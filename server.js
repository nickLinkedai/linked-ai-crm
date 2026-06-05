const express = require('express');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');
const { google }       = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_ANON_KEY;
const GOOGLE_ID       = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET   = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL        = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI    = `${BASE_URL}/auth/google/callback`;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── OAuth client factory ──
function oauthClient(tokens = null) {
  const c = new google.auth.OAuth2(GOOGLE_ID, GOOGLE_SECRET, REDIRECT_URI);
  if (tokens) c.setCredentials(tokens);
  return c;
}

// ── Serve frontend ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Kick off Google OAuth ──
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_ID) return res.status(503).send('Google credentials not configured yet.');
  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
  res.redirect(url);
});

// ── OAuth callback ──
app.get('/auth/google/callback', async (req, res) => {
  try {
    const client = oauthClient();
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);

    const { data: info } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();

    await supabase.from('google_accounts').upsert({
      email:         info.email,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expiry:  new Date(tokens.expiry_date).toISOString(),
    }, { onConflict: 'email' });

    await syncAccount(info.email, tokens);
    res.redirect('/?connected=' + encodeURIComponent(info.email));
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

// ── Disconnect account ──
app.delete('/api/accounts/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  await supabase.from('calendar_events').delete().eq('google_account', email);
  await supabase.from('google_accounts').delete().eq('email', email);
  res.json({ ok: true });
});

// ── List connected accounts ──
app.get('/api/accounts', async (req, res) => {
  const { data } = await supabase
    .from('google_accounts')
    .select('email, synced_at, created_at')
    .order('created_at');
  res.json(data || []);
});

// ── Calendar events for the frontend ──
app.get('/api/events', async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 7  * 86400000).toISOString();
  const to   = req.query.to   || new Date(Date.now() + 60 * 86400000).toISOString();
  const { data } = await supabase
    .from('calendar_events')
    .select('*')
    .gte('start_time', from)
    .lte('start_time', to)
    .order('start_time');
  res.json(data || []);
});

// ── Sync one account ──
async function syncAccount(email, tokens) {
  const client = oauthClient(tokens);

  // Refresh if close to expiry
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - 300000) {
    const { credentials } = await client.refreshAccessToken();
    tokens = credentials;
    await supabase.from('google_accounts').update({
      access_token: credentials.access_token,
      token_expiry: new Date(credentials.expiry_date).toISOString(),
    }).eq('email', email);
    client.setCredentials(credentials);
  }

  const cal  = google.calendar({ version: 'v3', auth: client });
  const now  = new Date();
  const { data } = await cal.events.list({
    calendarId:  'primary',
    timeMin:     new Date(now - 7  * 86400000).toISOString(),
    timeMax:     new Date(now.getTime() + 60 * 86400000).toISOString(),
    singleEvents: true,
    orderBy:     'startTime',
    maxResults:  500,
  });

  const rows = (data.items || []).map(e => ({
    id:             `${email}_${e.id}`,
    google_account: email,
    title:          e.summary    || '(No title)',
    description:    e.description || '',
    start_time:     e.start?.dateTime || e.start?.date,
    end_time:       e.end?.dateTime   || e.end?.date,
    all_day:        !!e.start?.date && !e.start?.dateTime,
    location:       e.location   || '',
    html_link:      e.htmlLink   || '',
  }));

  if (rows.length) {
    await supabase.from('calendar_events').upsert(rows, { onConflict: 'id' });
  }

  await supabase.from('google_accounts')
    .update({ synced_at: new Date().toISOString() })
    .eq('email', email);

  console.log(`Synced ${rows.length} events for ${email}`);
}

// ── Sync all connected accounts ──
async function syncAll() {
  if (!GOOGLE_ID) return;
  const { data: accounts } = await supabase.from('google_accounts').select('*');
  if (!accounts?.length) return;
  for (const acc of accounts) {
    try {
      await syncAccount(acc.email, {
        access_token:  acc.access_token,
        refresh_token: acc.refresh_token,
        expiry_date:   new Date(acc.token_expiry).getTime(),
      });
    } catch (err) {
      console.error(`Sync failed for ${acc.email}:`, err.message);
    }
  }
}

// Sync on startup + every 5 minutes
syncAll();
setInterval(syncAll, 5 * 60 * 1000);

app.listen(PORT, () => console.log(`Linked AI CRM on port ${PORT}`));
