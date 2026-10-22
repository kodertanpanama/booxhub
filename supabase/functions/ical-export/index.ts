import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function icsDate(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d + "T00:00:00Z") : d;
  return dt.toISOString().replace(/[-:]/g, "").split("T")[0] + "T000000Z";
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    // Laluan: /ical-export?token=<suapan>&slug=<slug-bilik>&scope=all
    const expected = Deno.env.get("ICAL_EXPORT_TOKEN");
    if (!expected) {
      return new Response("Server misconfigured: ICAL_EXPORT_TOKEN secret is not set.", { status: 500, headers: corsHeaders });
    }
    const token = url.searchParams.get("token") ?? "";
    if (!timingSafeEqual(token, expected)) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }
    const slug = url.searchParams.get("slug");
    if (!slug) {
      return new Response("slug diperlukan", { status: 400, headers: corsHeaders });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: room, error: roomError } = await admin
      .from("room_types").select("id, name, total_units").eq("slug", slug).maybeSingle();
    if (roomError) throw roomError;
    if (!room) {
      return new Response("slug bilik tidak dijumpai", { status: 404, headers: corsHeaders });
    }

    // Unit yang sudah ditempah / diblok pada setiap malam = unit yang "tidak tersedia"
    // untuk platform luar. Paparkan sebagai VEVENT blok supaya OTA tidak menjual unit itu.
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);

    // Tempahan B2B aktif (bukan demo): kumpulkan julat tarikh setiap tempahan.
    const { data: bookings, error: bookingError } = await admin
      .from("bookings")
      .select("id, check_in, check_out")
      .in("status", ["PENDING_DEPOSIT", "CONFIRMED_PARTIAL", "FULLY_PAID"])
      .gte("check_out", today)
      .lte("check_in", horizon);
    if (bookingError) throw bookingError;

    const { data: blocks, error: blockError } = await admin
      .from("inventory_blocks")
      .select("id, start_date, end_date, blocked_units, source, reason")
      .gte("end_date", today)
      .lte("start_date", horizon)
      .eq("room_type_id", room.id);
    if (blockError) throw blockError;

    const bookingRooms = bookings && bookings.length > 0
      ? await admin
          .from("booking_rooms")
          .select("booking_id, quantity")
          .eq("room_type_id", room.id)
          .in("booking_id", (bookings as { id: string }[]).map((b) => b.id))
      : { data: [], error: null };
    if (bookingRooms.error) throw bookingRooms.error;

    const qtyByBooking = new Map<string, number>(
      ((bookingRooms.data ?? []) as { booking_id: string; quantity: number }[]).map((r) => [r.booking_id, r.quantity]),
    );

    const lines: string[] = [];
    lines.push("BEGIN:VCALENDAR");
    lines.push("VERSION:2.0");
    lines.push("PRODID:-//Perhentian Bay B2B//Kalendar Bilik//MS");
    lines.push("CALSCALE:GREGORIAN");
    lines.push("METHOD:PUBLISH");
    lines.push(`X-WR-CALNAME:Perhentian Bay - ${room.name}`);

    let seq = 0;
    for (const b of (bookings ?? []) as { id: string; check_in: string; check_out: string }[]) {
      const qty = qtyByBooking.get(b.id) ?? 0;
      if (qty <= 0) continue;
      seq += 1;
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:b2b-${b.id}-${room.id}@perhentianbay`);
      lines.push(`DTSTAMP:${stamp()}`);
      lines.push(`DTSTART;VALUE=DATE:${icsDate(b.check_in)}`);
      // DTEND eksklusif: tempahan sehingga check_out bermakna malam terakhir = check_out - 1.
      const lastNight = new Date(b.check_out + "T00:00:00Z");
      lastNight.setUTCDate(lastNight.getUTCDate() - 1);
      lines.push(`DTEND;VALUE=DATE:${icsDate(lastNight)}`);
      lines.push(`SUMMARY:Ditempah (${qty} unit)`);
      lines.push("END:VEVENT");
    }

    for (const blk of (blocks ?? []) as { id: string; start_date: string; end_date: string; source: string; reason: string }[]) {
      seq += 1;
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:blk-${blk.id}@perhentianbay`);
      lines.push(`DTSTAMP:${stamp()}`);
      lines.push(`DTSTART;VALUE=DATE:${icsDate(blk.start_date)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate(blk.end_date)}`);
      lines.push(`SUMMARY:Diblok (${blk.source}${blk.reason ? ": " + blk.reason : ""})`);
      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    return new Response(lines.join("\r\n"), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/calendar; charset=utf-8" },
    });
  } catch (err) {
    console.error("ical-export failed", err);
    return new Response("Gagal menjana kalendar", {
      status: 500,
      headers: corsHeaders,
    });
  }
});