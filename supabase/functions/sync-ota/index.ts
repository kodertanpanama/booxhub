import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// CORS: hadkan kepada asal yang dibenarkan (SYNC_OTA_ALLOWED_ORIGINS, dipisah koma).
// Jika tidak ditetapkan, tiada pengepala Allow-Origin dihantar (panggilan pelayan/cron tidak terjejas).
const ALLOWED_ORIGINS = (Deno.env.get("SYNC_OTA_ALLOWED_ORIGINS") ?? "")
  .split(",").map((o) => o.trim()).filter(Boolean);

let corsHeaders: Record<string, string> = {};

function corsFor(req: Request): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Sync-Secret",
    "Vary": "Origin",
  };
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) base["Access-Control-Allow-Origin"] = origin;
  return base;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Benarkan: (1) cron/pelayan dengan x-sync-secret == SYNC_OTA_SECRET, atau
// (2) pentadbir yang log masuk (JWT) dengan peranan super_admin/ops_admin yang diluluskan
//     (butang "Segerak" di /admin/blocks), supaya rahsia tidak perlu didedahkan ke pelayar.
async function isAuthorized(req: Request): Promise<boolean> {
  const secret = Deno.env.get("SYNC_OTA_SECRET");
  const provided = req.headers.get("x-sync-secret");
  if (secret && provided && timingSafeEqual(provided, secret)) return true;

  const authHeader = req.headers.get("authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return false;
  const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData } = await anon.auth.getUser(jwt);
  if (!userData?.user) return false;
  const { data: profile } = await anon
    .from("profiles").select("role, status").eq("id", userData.user.id).maybeSingle();
  return !!profile && profile.status === "approved" && ["super_admin", "ops_admin"].includes(profile.role);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (!Deno.env.get("SYNC_OTA_SECRET")) {
    return json({ error: "Server misconfigured: SYNC_OTA_SECRET secret is not set." }, 500);
  }
  if (!(await isAuthorized(req))) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const url = new URL(req.url);
    const manual = url.searchParams.get("manual") === "1";
    const feedId = url.searchParams.get("feed");

    if (req.method !== "POST" && !manual) {
      return json({ error: "Kaedah tidak dibenarkan" }, 405);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Senarai suapan yang perlu disegerak (lebih 14 minit) atau suapan khusus manual.
    let feeds: { id: string; room_type_id: string; label: string; url: string }[];
    if (feedId) {
      const { data, error } = await admin
        .from("ota_calendar_feeds").select("id, room_type_id, label, url").eq("id", feedId).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Suapan tidak dijumpai" }, 404);
      feeds = [data];
    } else {
      const { data, error } = await admin.rpc("due_ical_feeds");
      if (error) throw error;
      feeds = (data ?? []) as typeof feeds;
    }

    const results: { feed_id: string; label: string; ok: boolean; blocks: number; error: string | null }[] = [];

    for (const feed of feeds) {
      let ok = false;
      let blocks = 0;
      let errMsg: string | null = null;
      try {
        const res = await fetch(feed.url, {
          headers: { "User-Agent": "PerhentianBayB2B-Sync/1.0" },
          redirect: "follow",
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
          errMsg = `HTTP ${res.status}`;
        } else {
          const body = await res.text();
          const { data: imported, error: importError } = await admin.rpc("import_ical_blocks", {
            p_room: feed.room_type_id,
            p_ical: body,
          });
          if (importError) {
            errMsg = importError.message;
          } else {
            blocks = Number(imported ?? 0);
            ok = true;
          }
        }
      } catch (e) {
        errMsg = e instanceof Error ? e.message : "Gagal mengambil kalendar";
      }

      const { error: recError } = await admin.rpc("record_feed_sync", {
        p_feed: feed.id,
        p_status: ok ? `OK: ${blocks} blok` : `Gagal: ${errMsg ?? "tidak diketahui"}`,
      });
      if (recError) console.error("record_feed_sync failed", recError);

      results.push({ feed_id: feed.id, label: feed.label, ok, blocks, error: errMsg });
    }

    return json({ synced: results.length, results });
  } catch (err) {
    console.error("sync-ota failed", err);
    return json({ error: "Penyegerakan gagal. Sila cuba lagi." }, 500);
  }
});