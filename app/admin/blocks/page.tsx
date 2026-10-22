'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, CalendarOff, ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/shell/app-shell';
import { EmptyState, SkeletonList } from '@/components/shell/stat-card';
import { RequireRole } from '@/components/auth/require-role';
import { supabase } from '@/lib/supabase';
import { formatDate, friendlyError, malaysiaToday, toISODate } from '@/lib/format';
import { cn } from '@/lib/utils';

type Block = {
  id: string;
  room_type_id: string;
  start_date: string;
  end_date: string;
  blocked_units: number;
  source: string;
  reason: string;
  room_types?: { name: string };
};

type Feed = {
  id: string;
  room_type_id: string;
  label: string;
  url: string;
  is_active: boolean;
  last_synced_at: string | null;
  last_sync_status: string;
  room_types?: { name: string; slug: string };
};

const ROOM_SELECT = 'id, room_type_id, start_date, end_date, blocked_units, source, reason, room_types(name)';
const FEED_SELECT = 'id, room_type_id, label, url, is_active, last_synced_at, last_sync_status, room_types(name, slug)';

const SOURCE_META: Record<string, { label: string; className: string }> = {
  MANUAL_MAINTENANCE: { label: 'Penyelenggaraan', className: 'bg-slate-100 text-slate-700' },
  WALK_IN: { label: 'Walk-in', className: 'bg-sand-100 text-sand-900' },
  MANUAL_OTA: { label: 'OTA manual', className: 'bg-ocean-50 text-ocean-800' },
  OTA_SYNC: { label: 'OTA sync', className: 'bg-coral-50 text-coral-800' },
};

// Build the public iCal export URL for a room type slug. Edge functions sit
// on <project>.functions.supabase.co, not inside the /rest/v1 path.
// The feed now requires ?token= matching the ICAL_EXPORT_TOKEN Supabase secret.
// The secret is never shipped to the browser: replace the placeholder before
// pasting the URL into the OTA.
function icalExportUrl(slug: string) {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\.supabase\.co$/, '')}.functions.supabase.co/ical-export?slug=${slug}&token=<ICAL_EXPORT_TOKEN>`;
}

function BlockDialog({ rooms, onClose, onSaved }: {
  rooms: { id: string; name: string; total_units: number }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? '');
  const [start, setStart] = useState(toISODate(malaysiaToday()));
  const [end, setEnd] = useState(toISODate(malaysiaToday()));
  const [units, setUnits] = useState('1');
  const [source, setSource] = useState('MANUAL_MAINTENANCE');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!roomId) { toast.error('Pilih jenis bilik dahulu.'); return; }
    if (end < start) { toast.error('Tarikh tamat tidak boleh sebelum tarikh mula.'); return; }
    const n = Number(units);
    if (!Number.isFinite(n) || n < 1) { toast.error('Unit mesti sekurang-kurangnya 1.'); return; }
    setSaving(true);
    const { error } = await supabase.rpc('set_inventory_block', {
      p_room: roomId, p_start: start, p_end: end, p_units: n,
      p_source: source, p_reason: reason.trim(),
    });
    setSaving(false);
    if (error) { toast.error(friendlyError(error, 'Gagal menambah blok.')); return; }
    toast.success('Blok bilik ditambah.');
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>Tutup bilik (blok unit)</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Jenis bilik</Label>
            <Select value={roomId} onValueChange={setRoomId}>
              <SelectTrigger><SelectValue placeholder="Pilih bilik" /></SelectTrigger>
              <SelectContent>
                {rooms.map((r) => <SelectItem key={r.id} value={r.id}>{r.name} ({r.total_units} unit)</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label htmlFor="blk-start">Tarikh mula</Label>
              <Input id="blk-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="blk-end">Tarikh tamat</Label>
              <Input id="blk-end" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label htmlFor="blk-units">Unit ditutup</Label>
              <Input id="blk-units" type="number" min={1} value={units} onChange={(e) => setUnits(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Sebab</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MANUAL_MAINTENANCE">Penyelenggaraan</SelectItem>
                  <SelectItem value="WALK_IN">Walk-in / tetamu langsung</SelectItem>
                  <SelectItem value="MANUAL_OTA">Tempahan OTA manual</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5"><Label htmlFor="blk-reason">Nota (pilihan)</Label>
            <Input id="blk-reason" maxLength={200} value={reason} placeholder="Contoh: pengubahsuaian bilik air" onChange={(e) => setReason(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Batal</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Simpan blok</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FeedDialog({ rooms, onClose, onSaved }: {
  rooms: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!roomId) { toast.error('Pilih jenis bilik dahulu.'); return; }
    const u = url.trim();
    if (!/^https?:\/\//.test(u)) { toast.error('Masukkan pautan kalendar (.ics) yang sah, bermula dengan https://'); return; }
    setSaving(true);
    const { error } = await supabase.from('ota_calendar_feeds').insert({
      room_type_id: roomId, label: label.trim() || 'Kalendar OTA', url: u, is_active: true,
    });
    setSaving(false);
    if (error) { toast.error(friendlyError(error, 'Gagal menambah suapan.')); return; }
    toast.success('Suapan kalendar ditambah. Penyegerakan pertama akan berjalan tidak lama lagi.');
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Pautan kalendar OTA (iCal)</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Tampal pautan kalendar &quot;.ics&quot; dari Booking.com / Airbnb bagi jenis bilik ini. Sistem akan menyegerakkan
            tempahan luar setiap 15 minit dan menutup unit yang sama secara automatik.
          </p>
          <div className="space-y-1.5">
            <Label>Jenis bilik</Label>
            <Select value={roomId} onValueChange={setRoomId}>
              <SelectTrigger><SelectValue placeholder="Pilih bilik" /></SelectTrigger>
              <SelectContent>
                {rooms.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label htmlFor="feed-label">Nama suapan</Label>
            <Input id="feed-label" maxLength={120} value={label} placeholder="Contoh: Booking.com - Quad Seaview" onChange={(e) => setLabel(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="feed-url">Pautan kalendar (.ics)</Label>
            <Input id="feed-url" type="url" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Batal</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Simpan suapan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BlocksInner() {
  const [rooms, setRooms] = useState<{ id: string; name: string; slug: string; total_units: number }[]>([]);
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [feeds, setFeeds] = useState<Feed[] | null>(null);
  const [showBlock, setShowBlock] = useState(false);
  const [showFeed, setShowFeed] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const [roomsRes, blocksRes, feedsRes] = await Promise.all([
      supabase.from('room_types').select('id, name, slug, total_units').order('sort_order'),
      supabase.from('inventory_blocks').select(ROOM_SELECT).order('start_date'),
      supabase.from('ota_calendar_feeds').select(FEED_SELECT).order('created_at'),
    ]);
    if (roomsRes.error) toast.error(friendlyError(roomsRes.error, 'Gagal memuatkan bilik.'));
    if (blocksRes.error) toast.error(friendlyError(blocksRes.error, 'Gagal memuatkan blok.'));
    if (feedsRes.error) toast.error(friendlyError(feedsRes.error, 'Gagal memuatkan suapan OTA.'));
    setRooms((roomsRes.data ?? []) as typeof rooms);
    setBlocks(((blocksRes.data ?? []) as unknown[]) as Block[]);
    setFeeds(((feedsRes.data ?? []) as unknown[]) as Feed[]);
  }, []);

  useEffect(() => { load(); }, [load]);

  const removeBlock = async (id: string) => {
    const { error } = await supabase.rpc('clear_inventory_block', { p_block: id });
    if (error) { toast.error(friendlyError(error, 'Gagal memadam blok.')); return; }
    toast.success('Blok dipadam.');
    load();
  };

  const removeFeed = async (id: string) => {
    const { error } = await supabase.from('ota_calendar_feeds').delete().eq('id', id);
    if (error) { toast.error(friendlyError(error, 'Gagal memadam suapan.')); return; }
    toast.success('Suapan dipadam.');
    load();
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('sync-ota', { body: { manual: true } });
      if (error) throw error;
      const result = data as { synced: number; results?: { ok: boolean; error: string | null }[] };
      const failed = result.results?.some((r) => !r.ok);
      if (failed) toast.warning('Penyegerakan selesai dengan kegagalan pada sebahagian suapan.');
      else toast.success(`Penyegerakan selesai (${result.synced} suapan diproses).`);
    } catch (e) {
      toast.error(friendlyError(e, 'Penyegerakan gagal. Sila cuba lagi.'));
    }
    setSyncing(false);
    load();
  };

  const roomName = (id: string) => rooms.find((r) => r.id === id)?.name ?? '—';
  const roomSlug = (id: string) => rooms.find((r) => r.id === id)?.slug ?? '';

  return (
    <>
      <PageHeader title="Blok Bilik & OTA" description="Tutup unit untuk penyelenggaraan, walk-in, dan segerakkan kalendar Booking.com / Airbnb."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={syncNow} disabled={syncing}>
              {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />} Segerak sekarang
            </Button>
            <Button variant="outline" onClick={() => setShowFeed(true)}><CalendarClock className="mr-2 h-4 w-4" /> Pautan OTA</Button>
            <Button onClick={() => setShowBlock(true)}><Plus className="mr-2 h-4 w-4" /> Tutup bilik</Button>
          </div>
        } />

      <section className="mb-8">
        <h2 className="mb-3 font-semibold text-ocean-950">Blok aktif</h2>
        {!blocks ? <SkeletonList rows={3} /> : blocks.length === 0 ? (
          <div className="rounded-lg border bg-card">
            <EmptyState icon={CalendarOff} title="Tiada blok aktif">
              Semua unit buat masa ini terbuka untuk tempahan. Tambah blok untuk penyelenggaraan, walk-in atau tempahan OTA manual.
            </EmptyState>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {blocks.map((b) => {
              const meta = SOURCE_META[b.source] ?? SOURCE_META.MANUAL_MAINTENANCE;
              return (
                <div key={b.id} className="flex items-start justify-between gap-3 rounded-lg border bg-card p-4 shadow-stripe-card">
                  <div className="min-w-0">
                    <p className="font-semibold text-ocean-950">{b.room_types?.name ?? roomName(b.room_type_id)}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatDate(b.start_date, 'd MMM')} – {formatDate(b.end_date, 'd MMM yyyy')} · {b.blocked_units} unit
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-semibold', meta.className)}>{meta.label}</span>
                      {b.reason && <span className="text-xs text-muted-foreground">{b.reason}</span>}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => removeBlock(b.id)} disabled={b.source === 'OTA_SYNC'}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" /> {b.source === 'OTA_SYNC' ? 'Auto' : 'Padam'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-semibold text-ocean-950">Pautan kalendar OTA</h2>
        {!feeds ? <SkeletonList rows={2} /> : feeds.length === 0 ? (
          <div className="rounded-lg border bg-card">
            <EmptyState icon={CalendarClock} title="Belum ada pautan OTA"
              action={<Button onClick={() => setShowFeed(true)}><Plus className="mr-2 h-4 w-4" /> Tambah pautan</Button>}>
              Tambah pautan kalendar (.ics) dari Booking.com atau Airbnb supaya tempahan luar menutup unit di sini secara automatik.
            </EmptyState>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {feeds.map((f) => (
              <div key={f.id} className="rounded-lg border bg-card p-4 shadow-stripe-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-ocean-950">{f.label || f.room_types?.name}</p>
                    <p className="text-sm text-muted-foreground">{f.room_types?.name}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={f.url}>{f.url}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => removeFeed(f.id)}><Trash2 className="mr-1.5 h-3.5 w-3.5" /> Padam</Button>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
                  <span className={cn('rounded-full px-2.5 py-0.5 font-semibold',
                    f.last_sync_status.startsWith('OK') ? 'bg-emerald-50 text-emerald-700' : f.last_synced_at ? 'bg-red-50 text-red-700' : 'bg-muted text-muted-foreground')}>
                    {f.last_sync_status || 'Belum disegerak'}
                  </span>
                  <a href={icalExportUrl(roomSlug(f.room_type_id))} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-ocean-700 hover:underline">
                    <ExternalLink className="h-3.5 w-3.5" /> Eksport iCal
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {showBlock && (
        <BlockDialog rooms={rooms} onClose={() => setShowBlock(false)} onSaved={() => { setShowBlock(false); load(); }} />
      )}
      {showFeed && (
        <FeedDialog rooms={rooms} onClose={() => setShowFeed(false)} onSaved={() => { setShowFeed(false); load(); }} />
      )}
    </>
  );
}

export default function BlocksPage() {
  return <RequireRole roles={['super_admin', 'ops_admin']}><BlocksInner /></RequireRole>;
}