import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// Boleh dihadkan kepada domain produksi melalui pemboleh ubah persekitaran
// DEMO_ALLOWED_ORIGINS, contoh: "https://portal.example.com,https://staging.example.com"
const ALLOWED_ORIGINS = Deno.env.get("DEMO_ALLOWED_ORIGINS") ?? "*";

function corsFor(req: Request) {
  if (ALLOWED_ORIGINS === "*") return corsHeaders;
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.split(",").map((o) => o.trim()).includes(origin)) {
    return { ...corsHeaders, "Access-Control-Allow-Origin": origin };
  }
  return corsHeaders;
}

// Wajib ditetapkan sebagai rahsia Supabase; tiada nilai lalai.
const DEMO_PASSWORD = Deno.env.get("DEMO_PASSWORD");

const ACCOUNTS = [
  { key: "admin", email: "admin@demo.perhentianbay.my", full_name: "Demo Admin" },
  { key: "agent", email: "ejen@demo.perhentianbay.my", full_name: "Demo Ejen" },
  { key: "applicant1", email: "pemohon1@demo.perhentianbay.my", full_name: "Rosli Ahmad" },
  { key: "applicant2", email: "pemohon2@demo.perhentianbay.my", full_name: "Grace Tan" },
];

const RECEIPT_PATH = "demo/resit-contoh.pdf";

function samplePdf(): Uint8Array {
  const text = [
    "BT /F1 18 Tf 60 760 Td (RESIT PEMBAYARAN - CONTOH DEMO) Tj ET",
    "BT /F1 12 Tf 60 730 Td (Bank: Maybank2u  |  Jenis: IBG / DuitNow) Tj ET",
    "BT /F1 12 Tf 60 710 Td (Penerima: Perhentian Bay Chalet) Tj ET",
    "BT /F1 12 Tf 60 690 Td (Status: Berjaya) Tj ET",
    "BT /F1 10 Tf 60 660 Td (Dokumen ini dijana untuk mod demo sahaja.) Tj ET",
  ].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => (out += `${String(off).padStart(10, "0")} 00000 n \n`));
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsFor(req) });
  }

  if (!DEMO_PASSWORD) {
    return json(req, { error: "Server misconfigured: DEMO_PASSWORD secret is not set." }, 500);
  }

  try {
    if (req.method !== "POST") return json(req, { error: "Kaedah tidak dibenarkan" }, 405);

    const body = await req.json().catch(() => ({}));
    const role = body?.role;
    if (role !== "admin" && role !== "agent") return json(req, { error: "Peranan tidak sah" }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: settings, error: settingsError } = await admin
      .from("app_settings").select("demo_enabled").eq("id", 1).maybeSingle();
    if (settingsError) throw settingsError;
    if (!settings?.demo_enabled) return json(req, { error: "Akses demo sedang dimatikan oleh pentadbir." }, 403);

    const { data: existing, error: existingError } = await admin
      .from("profiles").select("id, email").eq("is_demo", true);
    if (existingError) throw existingError;
    const byEmail = new Map((existing ?? []).map((p: { id: string; email: string }) => [p.email, p.id]));

    const { data: directory, error: directoryError } = await admin
      .from("demo_agent_directory").select("email, full_name");
    if (directoryError) throw directoryError;
    const loginEmails = new Set(ACCOUNTS.map((a) => a.email));
    const missing = (directory ?? []).filter(
      (d: { email: string }) => !loginEmails.has(d.email) && !byEmail.has(d.email),
    );
    for (let i = 0; i < missing.length; i += 8) {
      const results = await Promise.all(
        missing.slice(i, i + 8).map((d: { email: string; full_name: string }) =>
          admin.auth.admin.createUser({
            email: d.email,
            password: crypto.randomUUID() + "Aa1!",
            email_confirm: true,
            app_metadata: { demo: true },
            user_metadata: { full_name: d.full_name },
          })
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
    }

    for (const acc of ACCOUNTS) {
      const id = byEmail.get(acc.email);
      if (id) {
        const { error } = await admin.auth.admin.updateUserById(id, { password: DEMO_PASSWORD as string });
        if (error) throw error;
      } else {
        const { error } = await admin.auth.admin.createUser({
          email: acc.email,
          password: DEMO_PASSWORD as string,
          email_confirm: true,
          app_metadata: { demo: true },
          user_metadata: { full_name: acc.full_name },
        });
        if (error) throw error;
      }
    }

    const { error: prepError } = await admin.rpc("demo_prepare_accounts");
    if (prepError) throw prepError;

    const { error: uploadError } = await admin.storage
      .from("receipts")
      .upload(RECEIPT_PATH, samplePdf(), { contentType: "application/pdf", upsert: true });
    if (uploadError) console.error("demo receipt upload failed", uploadError);

    const account = ACCOUNTS.find((a) => a.key === role)!;
    return json(req, { email: account.email, password: DEMO_PASSWORD });
  } catch (err) {
    console.error("demo-access failed", err);
    return json(req, { error: "Akses demo tidak dapat disediakan. Sila cuba lagi." }, 500);
  }
});
