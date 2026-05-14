// ============================================================
// Rate My Campus Wellbeing — server.js
// Express app · Supabase backend · Mobile-first
// ============================================================

import express from 'express'
import session from 'express-session'
import rateLimit from 'express-rate-limit'
import { createClient } from '@supabase/supabase-js'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── Supabase clients ────────────────────────────────────────
// Anon client — used for public reads and anonymous inserts
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

// Service client — used for admin routes only
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// CampusMind client — second Supabase project for student wellbeing assessments
let supabaseCM = null
try {
  const cmUrl = process.env.CAMPUSMIND_SUPABASE_URL
  const cmKey = process.env.CAMPUSMIND_SUPABASE_KEY
  if (cmUrl && cmKey && cmUrl.startsWith('https://')) {
    supabaseCM = createClient(cmUrl, cmKey)
    console.log('[CampusMind] Supabase client initialised')
  } else {
    console.warn('[CampusMind] Skipping client — CAMPUSMIND_SUPABASE_URL missing or malformed')
  }
} catch(e) {
  console.warn('[CampusMind] Client init failed:', e.message)
}

// ── Express setup ───────────────────────────────────────────
const app = express()
app.set("trust proxy", 1)
app.use(session({
  secret: process.env.SESSION_SECRET || 'rmcw-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))

// ── Cache + robots headers ───────────────────────────────────
// express-session sets Cache-Control: private on every response.
// Override it: public pages get public caching + indexing signal;
// admin and receipt pages stay private + noindex.
app.use((req, res, next) => {
  const path = req.path
  const isAdmin   = path.startsWith('/burkmin') || path.startsWith('/api/burkmin')
  const isReceipt = path === '/receipt'
  if (isAdmin || isReceipt) {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  } else {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
    res.setHeader('X-Robots-Tag', 'index, follow')
  }
  next()
})

// ── Rate limiting ───────────────────────────────────────────
// Prevent spam submissions — 10 submissions per IP per hour
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions — please try again later' },
  statusCode: 429
})

const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions — please try again later' },
  statusCode: 429
})

// ── Session-based admin auth middlewares ─────────────────────
function requireAdminSession(req, res, next) {
  if (req.session?.admin === true) return next()
  res.redirect('/burkmin')
}
function requireAdminApi(req, res, next) {
  if (req.session?.admin === true) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

// ============================================================
// PAGE ROUTES
// ============================================================

// ── Landing page ────────────────────────────────────────────
app.get('/', async (req, res) => {
  const { data: campuses, error } = await supabase
    .from('campuses')
    .select('id, slug, name, system, city')
    .eq('active', true)
    .order('system')
    .order('name')

  if (error) {
    console.error('Error fetching campuses:', error)
    return res.status(500).send('Error loading campuses')
  }

  // Group by system for the dropdown
  const uc  = campuses.filter(c => c.system === 'UC')
  const csu = campuses.filter(c => c.system === 'CSU')
  const other = campuses.filter(c => c.system === 'Other')

  res.send(renderLanding(uc, csu, other))
})

// ── Submit flow (multi-step, client-side steps) ─────────────
app.get('/submit', async (req, res) => {
  const campusSlug = req.query.campus
  let campus = null

  const [campusResult, allCampusesResult] = await Promise.all([
    campusSlug
      ? supabase.from('campuses').select('id, slug, name, system, city').eq('slug', campusSlug).single()
      : Promise.resolve({ data: null }),
    supabase.from('campuses').select('id, slug, name, system').eq('active', true).order('system').order('name')
  ])

  campus = campusResult.data
  const allCampuses = allCampusesResult.data || []

  res.send(renderSubmitFlow(campus, allCampuses))
})

// ── Campus ratings API (year-filtered) ──────────────────────
app.get('/api/campus-ratings', async (req, res) => {
  const { campus_id, year } = req.query
  if (!campus_id) return res.status(400).json({ error: 'campus_id required' })
  const DIMS = ['physical','emotional','intellectual','social','spiritual','environmental','occupational','financial']
  let q = supabaseAdmin
    .from('submissions')
    .select('rating_physical,rating_emotional,rating_intellectual,rating_social,rating_spiritual,rating_environmental,rating_occupational,rating_financial')
    .eq('campus_id', campus_id)
    .neq('deleted', true)
  if (year) q = q.eq('year_in_school', year)
  let aq = supabaseAdmin
    .from('submissions')
    .select('submitters(archetype_self)')
    .eq('campus_id', campus_id)
    .neq('deleted', true)
  if (year) aq = aq.eq('year_in_school', year)

  const [{ data, error }, { data: archData }] = await Promise.all([q, aq])
  if (error) return res.status(500).json({ error: error.message })
  const avgs = {}
  for (const dim of DIMS) {
    const vals = (data || []).map(r => r[`rating_${dim}`]).filter(v => v !== null && v !== undefined)
    avgs[dim] = vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null
  }
  const ratingCount = (data || []).filter(r => DIMS.some(d => r[`rating_${d}`] != null)).length
  const archCounts = { guardian: 0, warrior: 0, guide: 0, healer: 0 }
  for (const s of (archData || [])) {
    const v = s.submitters?.archetype_self
    if (v && v in archCounts) archCounts[v]++
  }
  const archCount = Object.values(archCounts).reduce((a, b) => a + b, 0)
  res.json({ avgs, count: ratingCount, archCount, archCounts })
})

// ── Campus radar API (year-filtered, dual-layer) ────────────
app.get('/api/campus-radar', async (req, res) => {
  const { campus_id, campus_slug, campus_name, campus_city, year } = req.query
  if (!campus_id) return res.status(400).json({ error: 'campus_id required' })
  const DIMS = ['physical','emotional','intellectual','social','spiritual','environmental','occupational','financial']

  // ── Layer 1: Planning Capacity — RMCW submissions ──────────
  let q1 = supabaseAdmin.from('submissions')
    .select('rating_physical,rating_emotional,rating_intellectual,rating_social,rating_spiritual,rating_environmental,rating_occupational,rating_financial')
    .eq('campus_id', campus_id)
    .neq('deleted', true)
  if (year) q1 = q1.eq('year_in_school', year)
  const { data: rmcwRows, error: rmcwErr } = await q1
  if (rmcwErr) return res.status(500).json({ error: rmcwErr.message })

  const planningAvgs = {}
  for (const dim of DIMS) {
    const vals = (rmcwRows || []).map(r => r[`rating_${dim}`]).filter(v => v != null)
    planningAvgs[dim] = vals.length > 0 ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*10)/10 : null
  }
  const planningCount = (rmcwRows || []).length
  const planning = planningCount >= 1
    ? { ...planningAvgs, count: planningCount }
    : null

  // ── Layer 2: Social Capacity — CampusMind assessments ──────
  // q1–q8 map to Physical–Financial; college field is slug OR full name
  let social = null
  if (supabaseCM && (campus_slug || campus_name)) {
    try {
      let q2 = supabaseCM.from('assessments')
        .select('q1,q2,q3,q4,q5,q6,q7,q8,year_in_school')
      // OR match: slug | full name | "Name — City" (CampusMind format)
      const orParts = []
      if (campus_slug) orParts.push(`college.eq."${campus_slug}"`)
      if (campus_name) orParts.push(`college.eq."${campus_name}"`)
      if (campus_name && campus_city) orParts.push(`college.eq."${campus_name} \u2014 ${campus_city}"`)
      q2 = q2.or(orParts.join(','))
      if (year) q2 = q2.eq('year_in_school', year)
      const { data: cmRows, error: cmErr } = await q2
      if (!cmErr && cmRows && cmRows.length >= 1) {
        const qMap = ['q1','q2','q3','q4','q5','q6','q7','q8']
        const socialAvgs = {}
        DIMS.forEach((dim, i) => {
          const vals = cmRows.map(r => r[qMap[i]]).filter(v => v != null)
          socialAvgs[dim] = vals.length > 0 ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*10)/10 : null
        })
        social = { ...socialAvgs, count: cmRows.length }
      } else if (cmErr) {
        console.error('[radar] CampusMind query error:', cmErr.message)
      }
    } catch(e) {
      console.error('[radar] CampusMind fetch failed:', e.message)
    }
  }

  res.json({ planning, social })
})

// ── Campus public page ──────────────────────────────────────
app.get('/campus/:slug', async (req, res) => {
  const { slug } = req.params

  // Get campus details
  const { data: campus, error: campusError } = await supabase
    .from('campuses')
    .select('id, slug, name, system, city')
    .eq('slug', slug)
    .eq('active', true)
    .single()

  if (campusError || !campus) {
    return res.status(404).send(render404())
  }

  // Get archetype scores
  const { data: archetypeScores } = await supabase
    .from('archetype_scores')
    .select('archetype_tag, submission_count, pct_of_total, is_dominant')
    .eq('campus_id', campus.id)
    .order('submission_count', { ascending: false })

  // Get dimension scores
  const { data: dimensionScores } = await supabase
    .from('campus_scores')
    .select('dimension_tag, submission_count, pct_of_total')
    .eq('campus_id', campus.id)
    .order('submission_count', { ascending: false })

  // Get ALL submissions for voice cards (feedback_text OR guidance_text)
  const { data: allSubmissions } = await supabaseAdmin
    .from('submissions')
    .select(`
      id,
      feedback_text,
      guidance_text,
      dimension_tag,
      archetype_derived,
      subject_tag,
      year_in_school,
      major,
      created_at,
      submitters (
        community_tags,
        archetype_self
      )
    `)
    .eq('campus_id', campus.id)
    .neq('deleted', true)
    .order('created_at', { ascending: false })

  // Voice-eligible: has feedback_text OR guidance_text
  const voiceSubmissions = (allSubmissions || []).filter(s =>
    (s.feedback_text && s.feedback_text.trim()) ||
    (s.guidance_text  && s.guidance_text.trim())
  )
  console.log(`[campus] slug=${slug} campus_id=${campus.id} total=${allSubmissions?.length ?? 0} voice-eligible=${voiceSubmissions.length}`)

  // Total submission count
  const { count } = await supabaseAdmin
    .from('submissions')
    .select('id', { count: 'exact', head: true })
    .eq('campus_id', campus.id)
    .neq('deleted', true)

  // Fetch rating values + year for averages and year distribution
  const { data: ratingRows, error: ratingErr } = await supabaseAdmin
    .from('submissions')
    .select('year_in_school,rating_physical,rating_emotional,rating_intellectual,rating_social,rating_spiritual,rating_environmental,rating_occupational,rating_financial')
    .eq('campus_id', campus.id)
    .neq('deleted', true)

  if (ratingErr) console.error(`[campus] ratingErr=${ratingErr.message}`)

  // Compute per-dimension averages (exclude nulls)
  const RATING_DIMS = ['physical','emotional','intellectual','social','spiritual','environmental','occupational','financial']
  const ratingAvgs = {}
  let totalRatingsCount = 0
  if (ratingRows && ratingRows.length > 0) {
    totalRatingsCount = ratingRows.length
    for (const dim of RATING_DIMS) {
      const col = `rating_${dim}`
      const vals = ratingRows.map(r => r[col]).filter(v => v !== null && v !== undefined)
      ratingAvgs[dim] = vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null
    }
  }

  // Year distribution — only years that have at least 1 row
  const ALL_YEARS = ['1st','2nd','3rd','4th','5th+','grad','alumni','dropout']
  const yearDist = ALL_YEARS.filter(y => (ratingRows || []).some(r => r.year_in_school === y))

  // Archetype lean from archetype_self on submitters
  const archCounts = { guardian: 0, warrior: 0, guide: 0, healer: 0 }
  for (const s of (allSubmissions || [])) {
    const val = s.submitters?.archetype_self
    if (val && val in archCounts) archCounts[val]++
  }
  const archTotal = Object.values(archCounts).reduce((a, b) => a + b, 0)
  const archetypeLean = {
    counts: archCounts,
    total: archTotal,
    pcts: Object.fromEntries(
      Object.entries(archCounts).map(([k, v]) => [k, archTotal > 0 ? Math.round(v / archTotal * 100) : 0])
    ),
    dominant: archTotal >= 3
      ? Object.entries(archCounts).reduce((a, b) => b[1] > a[1] ? b : a)[0]
      : null
  }

  // Query CampusMind assessments for social capacity radar layer
  let wellbeingAvgs = null, wellbeingCount = 0
  if (supabaseCM) {
    try {
      const orParts = [`college.eq."${campus.slug}"`, `college.eq."${campus.name}"`]
      if (campus.city) orParts.push(`college.eq."${campus.name} \u2014 ${campus.city}"`)
      const orFilter = orParts.join(',')
      const { data: cmRows, error: cmErr } = await supabaseCM
        .from('assessments')
        .select('q1,q2,q3,q4,q5,q6,q7,q8')
        .or(orFilter)
      if (!cmErr && cmRows && cmRows.length >= 1) {
        wellbeingCount = cmRows.length
        wellbeingAvgs = {}
        const qMap = ['q1','q2','q3','q4','q5','q6','q7','q8']
        RATING_DIMS.forEach((dim, i) => {
          const vals = cmRows.map(r => r[qMap[i]]).filter(v => v != null)
          wellbeingAvgs[dim] = vals.length > 0 ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*10)/10 : null
        })
      } else if (cmErr) {
        console.error('[campus] CampusMind query error:', cmErr.message)
      }
    } catch(e) {
      console.error('[campus] CampusMind fetch failed:', e.message)
    }
  }

  res.send(renderCampusPage(
    campus,
    archetypeScores || [],
    dimensionScores || [],
    voiceSubmissions,
    count || 0,
    ratingAvgs,
    totalRatingsCount,
    yearDist,
    campus.id,
    archetypeLean,
    wellbeingAvgs,
    wellbeingCount
  ))
})

// ── Receipt page ────────────────────────────────────────────
app.get('/receipt', async (req, res) => {
  const { campus, campus_id, campus_slug, submitter_id, dimension, archetype } = req.query
  res.send(renderReceipt(campus, campus_id, campus_slug, submitter_id, dimension, archetype))
})

// ── POST /api/subscribe ─────────────────────────────────────
app.post('/api/subscribe', subscribeLimiter, async (req, res) => {
  const { email, campus_id, submitter_id, frequency, wants_summary } = req.body
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' })
  }
  try {
    const cleanEmail    = email.trim().toLowerCase()
    const wantsBool     = wants_summary === 'true' || wants_summary === true
    const isUUID        = v => v && /^[0-9a-f-]{36}$/.test(v)
    const campusUUID    = isUUID(campus_id)    ? campus_id    : null
    const submitterUUID = isUUID(submitter_id) ? submitter_id : null
    const { error: insErr } = await supabaseAdmin
      .from('email_subscriptions')
      .insert({
        email:        cleanEmail,
        campus_id:    campusUUID,
        submitter_id: submitterUUID,
        frequency:    frequency || null,
        wants_summary: wantsBool
      })
    if (insErr) throw new Error(insErr.message)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── /admin → 404 ────────────────────────────────────────────
app.get('/admin', (req, res) => res.status(404).send(render404()))
app.get('/admin/*', (req, res) => res.status(404).send(render404()))

// ── /burkmin — login page ────────────────────────────────────
app.get('/burkmin', (req, res) => {
  if (req.session?.admin) return res.redirect('/burkmin/dashboard')
  const err = req.query.error ? 'Incorrect password. Try again.' : ''
  res.send(renderAdminLogin(err))
})

app.post('/burkmin/login', (req, res) => {
  const { password } = req.body
  if (password && password === process.env.ADMIN_PASSWORD) {
    req.session.admin = true
    return res.redirect('/burkmin/dashboard')
  }
  res.redirect('/burkmin?error=1')
})

app.get('/burkmin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/burkmin'))
})

// ── /burkmin/dashboard ───────────────────────────────────────
app.get('/burkmin/dashboard', requireAdminSession, async (req, res) => {
  const { data: all } = await supabaseAdmin
    .from('submissions')
    .select(`
      id,
      feedback_text,
      guidance_text,
      dimension_tag,
      archetype_derived,
      subject_tag,
      year_in_school,
      major,
      communities,
      created_at,
      archived,
      deleted,
      feedback_flagged,
      feedback_flag_reason,
      guidance_flagged,
      guidance_flag_reason,
      rating_physical,
      rating_emotional,
      rating_intellectual,
      rating_social,
      rating_spiritual,
      rating_environmental,
      rating_occupational,
      rating_financial,
      campuses ( name, slug )
    `)
    .order('created_at', { ascending: false })

  const rows     = all || []
  const normal   = rows.filter(r => !r.deleted && !r.archived)
  const archived = rows.filter(r => !r.deleted &&  r.archived)
  const deleted  = rows.filter(r =>  r.deleted)
  res.send(renderAdminDashboard(normal, archived, deleted, rows.length))
})

// ============================================================
// API ROUTES
// ============================================================

// ── POST /api/submit ────────────────────────────────────────
app.post('/api/submit', submitLimiter, async (req, res) => {
  // Honeypot — bots fill hidden fields; real users never do
  if (req.body?.website) {
    console.log('Honeypot triggered')
    return res.json({ success: true })
  }

  const {
    campus_id,
    community_tags,
    archetype_self,
    subject_tag,
    prompt_mode,
    prompt_used,
    feedback_text,
    year_in_school,
    major,
    rating_physical,
    rating_emotional,
    rating_intellectual,
    rating_social,
    rating_spiritual,
    rating_environmental,
    rating_occupational,
    rating_financial
  } = req.body

  const { wish_text, wish_dimension } = req.body

  // Basic validation
  if (!campus_id) {
    return res.status(400).json({ error: 'Missing required field: campus_id' })
  }

  if (feedback_text && feedback_text.length > 500) {
    return res.status(400).json({
      error: 'Feedback must be 500 characters or fewer'
    })
  }

  if (wish_text && wish_text.length > 500) {
    return res.status(400).json({
      error: 'Wish text must be 500 characters or fewer'
    })
  }

  // Basic profanity check placeholder
  // Replace with a proper library in production
  const blocked = ['spam', 'test123']
  const lower = (feedback_text || '').toLowerCase()
  if (blocked.some(w => lower.includes(w))) {
    return res.status(400).json({ error: 'Feedback contains blocked content' })
  }

  try {
    // 1. Create submitter record
    const { data: submitter, error: submitterError } = await supabaseAdmin
      .from('submitters')
      .insert({
        community_tags: Array.isArray(community_tags)
          ? community_tags
          : (community_tags ? [community_tags] : []),
        archetype_self: archetype_self || null,
        student_type: 'unknown'
      })
      .select('id')
      .single()

    if (submitterError) {
      console.error('Supabase submitterError full:', JSON.stringify(submitterError, null, 2))
      throw submitterError
    }

    // 2. Create submission record
    // Schema: campus_id, submitter_id, subject_tag, archetype_derived (trigger),
    //   prompt_mode, prompt_used, feedback_text, year_in_school, major,
    //   flagged (bool NOT NULL), flag_reason, created_at (auto),
    //   deleted, guidance_dimension, guidance_text, communities (text),
    //   rating_physical/emotional/intellectual/social/spiritual/environmental/occupational/financial
    const feedbackTrimmed = (feedback_text || '').trim() || null

    // communities arrives as repeated FormData fields — normalise to comma-separated text
    const communitiesText = Array.isArray(community_tags)
      ? community_tags.join(',')
      : (community_tags || null)

    const insertPayload = {
      campus_id,
      submitter_id:  submitter.id,
      subject_tag:   subject_tag   || null,
      dimension_tag: null,
      prompt_mode:   prompt_mode   || null,
      prompt_used:   prompt_used   || null,
      feedback_text: feedbackTrimmed || null,
      year_in_school: year_in_school || null,
      major:          major          || null,
      flagged:        false,
      deleted:        false,
      guidance_text:      wish_text      || null,
      guidance_dimension: wish_dimension || null,
      communities:    communitiesText   || null,
      // 0 = N/A (student opted out) → store as null; 1–10 → store as integer
      rating_physical:      (rating_physical      && parseFloat(rating_physical)      > 0) ? Math.round(parseFloat(rating_physical))      : null,
      rating_emotional:     (rating_emotional     && parseFloat(rating_emotional)     > 0) ? Math.round(parseFloat(rating_emotional))     : null,
      rating_intellectual:  (rating_intellectual  && parseFloat(rating_intellectual)  > 0) ? Math.round(parseFloat(rating_intellectual))  : null,
      rating_social:        (rating_social        && parseFloat(rating_social)        > 0) ? Math.round(parseFloat(rating_social))        : null,
      rating_spiritual:     (rating_spiritual     && parseFloat(rating_spiritual)     > 0) ? Math.round(parseFloat(rating_spiritual))     : null,
      rating_environmental: (rating_environmental && parseFloat(rating_environmental) > 0) ? Math.round(parseFloat(rating_environmental)) : null,
      rating_occupational:  (rating_occupational  && parseFloat(rating_occupational)  > 0) ? Math.round(parseFloat(rating_occupational))  : null,
      rating_financial:     (rating_financial     && parseFloat(rating_financial)     > 0) ? Math.round(parseFloat(rating_financial))     : null
    }

    const { data: submission, error: submissionError } = await supabase
      .from('submissions')
      .insert(insertPayload)
      .select('id, archetype_derived')
      .single()

    if (submissionError) {
      console.error('Supabase submissionError full:', JSON.stringify(submissionError, null, 2))
      throw submissionError
    }

    res.json({
      success: true,
      submission_id: submission.id,
      submitter_id: submitter.id,
      archetype_derived: submission.archetype_derived
    })

  } catch (err) {
    console.error('Submit error:', err)
    res.status(500).json({ error: 'Failed to save submission' })
  }
})

// ── /api/burkmin/* — all require active session ──────────────

app.post('/api/burkmin/flag-feedback/:id', requireAdminApi, async (req, res) => {
  const { reason } = req.body
  const { error } = await supabaseAdmin.from('submissions')
    .update({ feedback_flagged: true, feedback_flag_reason: reason || 'Flagged by admin' })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

app.post('/api/burkmin/unflag-feedback/:id', requireAdminApi, async (req, res) => {
  const { error } = await supabaseAdmin.from('submissions')
    .update({ feedback_flagged: false, feedback_flag_reason: null })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

app.post('/api/burkmin/flag-guidance/:id', requireAdminApi, async (req, res) => {
  const { reason } = req.body
  const { error } = await supabaseAdmin.from('submissions')
    .update({ guidance_flagged: true, guidance_flag_reason: reason || 'Flagged by admin' })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

app.post('/api/burkmin/unflag-guidance/:id', requireAdminApi, async (req, res) => {
  const { error } = await supabaseAdmin.from('submissions')
    .update({ guidance_flagged: false, guidance_flag_reason: null })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

app.post('/api/burkmin/archive/:id', requireAdminApi, async (req, res) => {
  const { error } = await supabaseAdmin.from('submissions')
    .update({ archived: true })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

app.post('/api/burkmin/unarchive/:id', requireAdminApi, async (req, res) => {
  const { error } = await supabaseAdmin.from('submissions')
    .update({ archived: false })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

app.post('/api/burkmin/delete/:id', requireAdminApi, async (req, res) => {
  const { error } = await supabaseAdmin.from('submissions')
    .update({ deleted: true })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

app.post('/api/burkmin/restore/:id', requireAdminApi, async (req, res) => {
  const { error } = await supabaseAdmin.from('submissions')
    .update({ deleted: false })
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// ── GET /sitemap.xml ────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  const { data: campuses } = await supabase
    .from('campuses')
    .select('slug')
    .eq('active', true)
    .order('name')

  const base = 'https://ratemycampuswellbeing.com'
  const today = new Date().toISOString().split('T')[0]

  const staticUrls = ['/', '/submit'].map(path => `
  <url>
    <loc>${base}${path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${path === '/' ? 'daily' : 'monthly'}</changefreq>
    <priority>${path === '/' ? '1.0' : '0.7'}</priority>
  </url>`).join('')

  const campusUrls = (campuses || []).map(c => `
  <url>
    <loc>${base}/campus/${c.slug}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>`).join('')

  res.set('Content-Type', 'application/xml')
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticUrls}${campusUrls}
</urlset>`)
})

// ── GET /api/campuses ───────────────────────────────────────
app.get('/api/campuses', async (req, res) => {
  const { data, error } = await supabase
    .from('campuses')
    .select('id, slug, name, system, city')
    .eq('active', true)
    .order('system')
    .order('name')

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ============================================================
// HTML RENDER FUNCTIONS
// These return full HTML strings for each page.
// We'll replace these with proper template files in Phase 6.
// ============================================================

function renderLanding(uc, csu, other) {
  const ucOptions = uc.map(c =>
    `<option value="${c.id}" data-slug="${c.slug}">${c.name} — ${c.city}</option>`
  ).join('')
  const csuOptions = csu.map(c =>
    `<option value="${c.id}" data-slug="${c.slug}">${c.name} — ${c.city}</option>`
  ).join("")
  const browseCards = [...uc, ...csu].map(c =>
    `<a class="browse-card" href="/campus/${c.slug}">
      <span class="browse-card-system">${c.system}</span>
      <span class="browse-card-name">${c.name}</span>
      <span class="browse-card-city">${c.city || ""}</span>
    </a>`
  ).join("")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rate My Campus Wellbeing</title>
  <link rel="canonical" href="https://ratemycampuswellbeing.com/">
  <meta name="description" content="Anonymous student wellbeing ratings for UC and CSU campuses. See how students rate mental health, social connection, academic pressure, and more.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://ratemycampuswellbeing.com/">
  <meta property="og:title" content="Rate My Campus Wellbeing">
  <meta property="og:description" content="Anonymous student wellbeing ratings for UC and CSU campuses.">
  <meta property="og:site_name" content="Rate My Campus Wellbeing">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Rate My Campus Wellbeing">
  <meta name="twitter:description" content="Anonymous student wellbeing ratings for UC and CSU campuses.">
  <meta name="robots" content="index, follow">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="page-landing">
    <header class="nav">
      <span class="nav-logo">Rate My Campus Wellbeing</span>
      <a href="/submit" class="nav-link">Share Your Experience</a>
    </header>

    <main class="hero">
      <p class="eyebrow">Student Wellbeing · UC &amp; CSU Campuses</p>
      <h1>Your campus,<br>through student eyes.</h1>
      <p class="hero-sub">Rate the wellbeing experience.
         See how your campus really scores.</p>

      <div class="trust-row">
        <span class="trust-pill">Anonymous</span>
        <span class="trust-pill">Takes 2 min</span>
        <span class="trust-pill">No login required</span>
      </div>

      <div class="campus-select-card">
        <label for="campus-select" class="select-label">
          Select your campus to get started
        </label>
        <select id="campus-select" class="campus-dropdown">
          <option value="">— Choose your campus —</option>
          <optgroup label="University of California">
            ${ucOptions}
          </optgroup>
          <optgroup label="California State University">
            ${csuOptions}
          </optgroup>
          <optgroup label="Other">
            <option value="${other[0]?.id}" data-slug="other">Other</option>
          </optgroup>
        </select>
        <button id="start-btn" class="btn-primary" disabled>
          Share Your Experience →
        </button>
        <p class="select-hint">
          Or <a href="#browse">browse campus scores below</a>
        </p>
      </div>
    </main>
  </div>

  <script>
    const select = document.getElementById('campus-select')
    const btn    = document.getElementById('start-btn')

    select.addEventListener('change', () => {
      const opt = select.selectedOptions[0]
      btn.disabled = !select.value
      btn.dataset.slug = opt?.dataset.slug || ''
    })

    btn.addEventListener('click', () => {
      const slug = btn.dataset.slug
      if (slug) window.location.href = '/submit?campus=' + slug
    })
  </script>
  <section class="browse-section" id="browse">
    <h2>Browse All Campuses</h2>
    <p class="browse-sub">See how UC and CSU campuses score across 8 wellness dimensions.</p>
    <div class="browse-grid">${browseCards}</div>
  </section>
</body>
</html>`
}

function renderSubmitFlow(campus, allCampuses = []) {
  const uc    = allCampuses.filter(c => c.system === 'UC')
  const csu   = allCampuses.filter(c => c.system === 'CSU')
  const other = allCampuses.filter(c => c.system !== 'UC' && c.system !== 'CSU')

  const campusOptions = (list, label) =>
    list.length === 0 ? '' :
    `<optgroup label="${label}">${list.map(c =>
      `<option value="${c.id}" data-slug="${c.slug}"${campus?.id === c.id ? ' selected' : ''}>${c.name}</option>`
    ).join('')}</optgroup>`

  const campusDropdownOptions =
    campusOptions(uc, 'University of California') +
    campusOptions(csu, 'California State University') +
    campusOptions(other, 'Other')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Share Your Experience — Rate My Campus Wellbeing</title>
  <link rel="canonical" href="https://ratemycampuswellbeing.com/submit">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://ratemycampuswellbeing.com/submit">
  <meta property="og:title" content="Share Your Experience — Rate My Campus Wellbeing">
  <meta property="og:description" content="Anonymously rate your campus wellbeing experience. Takes 2 minutes.">
  <meta property="og:site_name" content="Rate My Campus Wellbeing">
  <meta name="twitter:card" content="summary">
  <meta name="description" content="Anonymously rate your campus wellbeing experience. Share how your UC or CSU campus supports student mental health, social connection, and more.">
  <meta name="twitter:title" content="Share Your Experience — Rate My Campus Wellbeing">
  <meta name="robots" content="index, follow">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="page-submit">
    <header class="submit-header">
      <a href="/" class="back-link">← Back</a>
      <div class="progress-bar">
        <div class="progress-fill" id="progress-fill" style="width: 25%"></div>
      </div>
      <span class="progress-label" id="progress-label">Step 1 of 4</span>
    </header>
    <!-- Context bar -->
    <div class="context-bar" id="context-bar" style="display:none">
      <div class="context-items" id="context-items"></div>
    </div>

    <!-- Step 1: Who are you? -->
    <div class="step" id="step-1">
      <p class="step-eyebrow">About you</p>
      <h2>Tell us a little about yourself</h2>
      <p class="step-sub">Your campus is required. Everything else is optional.</p>

      <h3 class="field-label">Which campus are you at? <span class="field-required">*</span></h3>
      <select id="step1-campus-select" class="campus-dropdown">
        <option value="">— Choose your campus —</option>
        ${campusDropdownOptions}
      </select>

      <h3 class="field-label" style="margin-top:1.5rem">What year are you? <span class="field-hint">(optional)</span></h3>
      <div class="bubble-grid" id="year-select">
        <button class="bubble" data-value="1st">1st year</button>
        <button class="bubble" data-value="2nd">2nd year</button>
        <button class="bubble" data-value="3rd">3rd year</button>
        <button class="bubble" data-value="4th">4th year</button>
        <button class="bubble" data-value="5th+">5th+ year</button>
        <button class="bubble" data-value="grad">Grad</button>
        <button class="bubble" data-value="alumni">Alumni</button>
        <button class="bubble" data-value="dropout">Dropout</button>
      </div>

      <h3 class="field-label" style="margin-top:1.75rem">Which communities are you part of?</h3>
      <p class="step-sub">Select all that apply. Completely optional.</p>
      <div class="bubble-grid" id="community-tags">
        <button class="bubble" data-value="on-campus-living">On Campus Living</button>
        <button class="bubble" data-value="commuter">Commuter</button>
        <button class="bubble" data-value="first-gen">First-Generation</button>
        <button class="bubble" data-value="transfer">Transfer</button>
        <button class="bubble" data-value="international">International</button>
        <button class="bubble" data-value="clubs">Clubs</button>
        <button class="bubble" data-value="intramurals">Intramurals</button>
        <button class="bubble" data-value="student-gov">Student Government</button>
        <button class="bubble" data-value="greek-life">Greek Life</button>
        <button class="bubble" data-value="athletics">Athletics</button>
        <button class="bubble" data-value="working">Working while Enrolled</button>
        <button class="bubble" data-value="parent">Parent while Enrolled</button>
        <button class="bubble" data-value="lgbtq">LGBTQ+</button>
        <button class="bubble" data-value="disability">Disability</button>
        <button class="bubble" data-value="veteran">Veteran</button>
        <button class="bubble" data-value="undocumented">Undocumented/DACA</button>
      </div>

      <h3 class="field-label" style="margin-top:1.75rem">Which best describes how you handle stress? <span class="field-hint">(optional)</span></h3>
      <p class="step-sub">Pick the one that feels most like you — or skip it.</p>
      <div class="bubble-grid" id="archetype-select" style="grid-template-columns:1fr 1fr">
        <button class="bubble archetype-bubble" data-value="guardian" style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:12px 14px;height:auto;text-align:left">
          <span style="font-size:20px">🏔️</span>
          <span style="font-weight:700;font-size:13px">Architect</span>
          <span style="font-size:11px;color:#888;white-space:normal;line-height:1.4">I plan ahead and prepare before problems arise</span>
        </button>
        <button class="bubble archetype-bubble" data-value="warrior" style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:12px 14px;height:auto;text-align:left">
          <span style="font-size:20px">⚡</span>
          <span style="font-weight:700;font-size:13px">Warrior</span>
          <span style="font-size:11px;color:#888;white-space:normal;line-height:1.4">I rise to the challenge when pressure is on</span>
        </button>
        <button class="bubble archetype-bubble" data-value="healer" style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:12px 14px;height:auto;text-align:left">
          <span style="font-size:20px">💦</span>
          <span style="font-weight:700;font-size:13px">Healer</span>
          <span style="font-size:11px;color:#888;white-space:normal;line-height:1.4">I recover and come back stronger after setbacks</span>
        </button>
        <button class="bubble archetype-bubble" data-value="guide" style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:12px 14px;height:auto;text-align:left">
          <span style="font-size:20px">🍃</span>
          <span style="font-weight:700;font-size:13px">Guide</span>
          <span style="font-size:11px;color:#888;white-space:normal;line-height:1.4">I spot patterns and anticipate what's coming</span>
        </button>
      </div>

      <input type="text" name="website" id="honeypot-website" tabindex="-1" autocomplete="off"
        style="position:absolute;left:-9999px;opacity:0;height:0">

      <button class="btn-primary step-next" data-next="2" id="step1-next" disabled>
        Continue →
      </button>
    </div>

    <!-- Step 2: Campus Rating Sliders -->
    <div class="step hidden" id="step-2">
      <p class="step-eyebrow">Rate Your Campus</p>
      <h2 id="step2-heading">How well did your campus support you?</h2>
      <p class="step-sub">Rate how well your campus supported you in each area. Select N/A if the service did not apply to your experience.</p>
      <div class="rating-progress-row">
        <span class="rating-progress-label"><span id="rating-touched-count">0</span> of 8 rated</span>
        <div class="rating-progress-track"><div class="rating-progress-fill" id="rating-progress-fill"></div></div>
      </div>

      <div class="rating-cards" id="rating-cards">

        <div class="rating-card" id="card-physical" style="--dim-color:#D4897A">
          <div class="rating-card-header">
            <span class="rating-dim-name">Physical</span>
            <span class="rating-dim-label">Nourishment, Rest &amp; Recovery</span>
          </div>
          <div class="rating-dynamic-label" id="label-physical">Physically — N/A</div>
          <div class="rating-slider-row">
            <input type="range" class="rating-slider" id="slider-physical" data-dim="physical" min="0" max="10" step="1" value="0" data-touched="false">
            <span class="rating-score" id="score-physical">0</span>
          </div>
          <details class="rating-accordion">
            <summary>What does this include? ▾</summary>
            <p>Think about access to food (dining halls, food pantries), quality of sleep environments in housing, campus recreation and fitness facilities, and access to student health services when you were sick or recovering.</p>
          </details>
        </div>

        <div class="rating-card" id="card-emotional" style="--dim-color:#E8B484">
          <div class="rating-card-header">
            <span class="rating-dim-name">Emotional</span>
            <span class="rating-dim-label">Mental Health &amp; Crisis Support</span>
          </div>
          <div class="rating-dynamic-label" id="label-emotional">Emotionally — N/A</div>
          <div class="rating-slider-row">
            <input type="range" class="rating-slider" id="slider-emotional" data-dim="emotional" min="0" max="10" step="1" value="0" data-touched="false">
            <span class="rating-score" id="score-emotional">0</span>
          </div>
          <details class="rating-accordion">
            <summary>What does this include? ▾</summary>
            <p>Think about counseling availability, wait times for appointments, crisis response, how openly mental health is talked about on campus, and whether you felt safe asking for help.</p>
          </details>
        </div>

        <div class="rating-card" id="card-intellectual" style="--dim-color:#E8D98A">
          <div class="rating-card-header">
            <span class="rating-dim-name">Intellectual</span>
            <span class="rating-dim-label">Academic Support &amp; Risk Navigation</span>
          </div>
          <div class="rating-dynamic-label" id="label-intellectual">Intellectually — N/A</div>
          <div class="rating-slider-row">
            <input type="range" class="rating-slider" id="slider-intellectual" data-dim="intellectual" min="0" max="10" step="1" value="0" data-touched="false">
            <span class="rating-score" id="score-intellectual">0</span>
          </div>
          <details class="rating-accordion">
            <summary>What does this include? ▾</summary>
            <p>Think about tutoring, academic advising quality, early warning systems when you were struggling, access to office hours, academic probation support, and how the campus communicated academic risk to you.</p>
          </details>
        </div>

        <div class="rating-card" id="card-social" style="--dim-color:#94C48A">
          <div class="rating-card-header">
            <span class="rating-dim-name">Social</span>
            <span class="rating-dim-label">Belonging, Inclusion &amp; Community</span>
          </div>
          <div class="rating-dynamic-label" id="label-social">Socially — N/A</div>
          <div class="rating-slider-row">
            <input type="range" class="rating-slider" id="slider-social" data-dim="social" min="0" max="10" step="1" value="0" data-touched="false">
            <span class="rating-score" id="score-social">0</span>
          </div>
          <details class="rating-accordion">
            <summary>What does this include? ▾</summary>
            <p>Think about whether you felt welcomed, whether you found your people, the quality of residential life, availability of student organizations, and how inclusive the campus culture felt across different identities and backgrounds.</p>
          </details>
        </div>

        <div class="rating-card" id="card-spiritual" style="--dim-color:#90C8D8">
          <div class="rating-card-header">
            <span class="rating-dim-name">Spiritual</span>
            <span class="rating-dim-label">Orientation, Purpose &amp; Campus Culture</span>
          </div>
          <div class="rating-dynamic-label" id="label-spiritual">Spiritually — N/A</div>
          <div class="rating-slider-row">
            <input type="range" class="rating-slider" id="slider-spiritual" data-dim="spiritual" min="0" max="10" step="1" value="0" data-touched="false">
            <span class="rating-score" id="score-spiritual">0</span>
          </div>
          <details class="rating-accordion">
            <summary>What does this include? ▾</summary>
            <p>Think about the quality of onboarding and orientation, whether student government felt representative, whether campus values aligned with yours, and whether the institution gave you a sense of direction beyond academics.</p>
          </details>
        </div>

        <div class="rating-card" id="card-environmental" style="--dim-color:#8A9AC4">
          <div class="rating-card-header">
            <span class="rating-dim-name">Environmental</span>
            <span class="rating-dim-label">Safety, Housing &amp; Campus Navigability</span>
          </div>
          <div class="rating-dynamic-label" id="label-environmental">Environmental Support — N/A</div>
          <div class="rating-slider-row">
            <input type="range" class="rating-slider" id="slider-environmental" data-dim="environmental" min="0" max="10" step="1" value="0" data-touched="false">
            <span class="rating-score" id="score-environmental">0</span>
          </div>
          <details class="rating-accordion">
            <summary>What does this include? ▾</summary>
            <p>Think about housing quality and availability, campus security and lighting, ease of getting around, access to quiet and open spaces, and whether the physical environment supported your ability to study and rest.</p>
          </details>
        </div>

        <div class="rating-card" id="card-occupational" style="--dim-color:#A886B8">
          <div class="rating-card-header">
            <span class="rating-dim-name">Occupational</span>
            <span class="rating-dim-label">Career Direction &amp; Opportunity Access</span>
          </div>
          <div class="rating-dynamic-label" id="label-occupational">Occupational Support — N/A</div>
          <div class="rating-slider-row">
            <input type="range" class="rating-slider" id="slider-occupational" data-dim="occupational" min="0" max="10" step="1" value="0" data-touched="false">
            <span class="rating-score" id="score-occupational">0</span>
          </div>
          <details class="rating-accordion">
            <summary>What does this include? ▾</summary>
            <p>Think about career services quality, internship and job placement support, ease of choosing or changing your major, access to research or work opportunities on campus, and whether faculty and advisors helped you connect your studies to your future.</p>
          </details>
        </div>

        <div class="rating-card" id="card-financial" style="--dim-color:#D4A0B8">
          <div class="rating-card-header">
            <span class="rating-dim-name">Financial</span>
            <span class="rating-dim-label">Affordability, Aid &amp; Value</span>
          </div>
          <div class="rating-dynamic-label" id="label-financial">Financially — N/A</div>
          <div class="rating-slider-row">
            <input type="range" class="rating-slider" id="slider-financial" data-dim="financial" min="0" max="10" step="1" value="0" data-touched="false">
            <span class="rating-score" id="score-financial">0</span>
          </div>
          <details class="rating-accordion">
            <summary>What does this include? ▾</summary>
            <p>Think about the clarity and accessibility of financial aid, scholarship availability, the overall burden of cost relative to what you received, and whether the campus helped you understand and manage your financial situation as a student.</p>
          </details>
        </div>

      </div>

      <button class="btn-primary" id="step2-next">
        Continue →
      </button>
    </div>

    <!-- Step 3: Your feedback -->
    <div class="step hidden" id="step-3">
      <p class="step-eyebrow">Your Voice</p>
      <h2 id="step3-heading">What's the wellbeing experience really like?</h2>

      <!-- Section 1 -->
      <div class="feedback-section">
        <h3 class="feedback-section-label">What do you want to share about your experience?</h3>

        <h3 class="field-label" style="margin-top:0.75rem;margin-bottom:0.5rem">Subject <span class="field-hint">(pick up to 2)</span></h3>
        <div class="bubble-grid single" id="subject-tags" style="margin-bottom:1rem">
          <button class="bubble" data-value="campus-overall">Campus Overall</button>
          <button class="bubble" data-value="department-major">Department / Major</button>
          <button class="bubble" data-value="facility">Facility</button>
          <button class="bubble" data-value="program">Program</button>
          <button class="bubble" data-value="resource">Resource</button>
          <button class="bubble" data-value="transition-experience">Transition Experience</button>
        </div>

        <select id="prompt-select" class="campus-dropdown">
          <option value="">— Choose a sentence starter (optional) —</option>
          <option value="The thing that helped me most was... ">The thing that helped me most was...</option>
          <option value="I wish I had known... ">I wish I had known...</option>
          <option value="The hardest part was... ">The hardest part was...</option>
          <option value="What surprised me about support here... ">What surprised me about support here...</option>
          <option value="If I could change one thing... ">If I could change one thing...</option>
        </select>

        <textarea
          id="feedback-text"
          class="feedback-textarea"
          placeholder="In your own words — what do students need to know? (optional)"
          maxlength="500"
        ></textarea>
        <div class="char-count">
          <span id="char-current">0</span> / 500
        </div>
      </div>

      <!-- Section 2 -->
      <div class="feedback-section">
        <h3 class="feedback-section-label">What do you wish you knew when you first attended college?</h3>

        <select id="wish-dimension" class="campus-dropdown">
          <option value="">Which area does this relate to?</option>
          <option value="physical">Physical</option>
          <option value="emotional">Emotional</option>
          <option value="intellectual">Intellectual</option>
          <option value="social">Social</option>
          <option value="spiritual">Spiritual</option>
          <option value="environmental">Environmental</option>
          <option value="occupational">Occupational</option>
          <option value="financial">Financial</option>
          <option value="holistic">Holistic — All Dimensions</option>
        </select>
        <p id="wish-dim-error" class="field-error" style="display:none">Please select an area before submitting.</p>

        <textarea
          id="wish-text"
          class="feedback-textarea"
          placeholder="Share what you wish someone had told you... (optional)"
          maxlength="500"
        ></textarea>
        <div class="char-count">
          <span id="wish-char-current">0</span> / 500
        </div>
      </div>

      <div class="optional-fields">
        <input
          type="text"
          id="major-input"
          class="major-input"
          placeholder="Major / Department (optional)"
          maxlength="80"
        >
      </div>

      <button class="btn-primary" id="submit-btn">
        Submit My Feedback →
      </button>
    </div>

    <!-- Step 4: Submitting -->
    <div class="step hidden" id="step-4">
      <div class="submitting-screen">
        <div class="submitting-icon">💬</div>
        <h2>Saving your voice...</h2>
        <p>Just a moment.</p>
      </div>
    </div>

  </div>

  <!-- Zero-rating soft-nudge modal -->
  <div id="na-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;align-items:center;justify-content:center;padding:20px">
    <div style="background:#fff;border-radius:16px;max-width:440px;width:100%;padding:28px 24px;box-shadow:0 8px 32px rgba(0,0,0,.18)">
      <h2 style="font-size:20px;font-weight:800;color:#1a1a2e;margin:0 0 12px">Just checking in.</h2>
      <p id="na-modal-body" style="font-size:15px;line-height:1.55;color:#444;margin:0 0 24px"></p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button id="na-modal-review"
          style="padding:13px 0;border-radius:10px;border:none;background:#3a86ff;color:#fff;font-size:15px;font-weight:700;cursor:pointer">
          Review My Ratings
        </button>
        <button id="na-modal-continue"
          style="padding:13px 0;border-radius:10px;border:2px solid #ccc;background:#fff;color:#555;font-size:15px;font-weight:600;cursor:pointer">
          Looks Good — Continue
        </button>
      </div>
    </div>
  </div>

  <script>
    // ── State ──────────────────────────────────────────────
    const state = {
      campus_id:       '${campus?.id || ''}',
      campus_slug:     '${campus?.slug || ''}',
      campus_name:     '${campus?.name || ''}',
      community_tags:  [],
      subject_tag:     null,
      subject_tags:    [],
      dimension_tag:   null,
      archetype_self:  null,
      feedback_text:   '',
      wish_text:       '',
      wish_dimension:  null,
      year_in_school:  null,
      major:           null,
      ratings: {
        physical: null, emotional: null, intellectual: null, social: null,
        spiritual: null, environmental: null, occupational: null, financial: null
      }
    }

    // ── Step navigation ────────────────────────────────────
    function updateContextBar() {
      const bar = document.getElementById('context-bar')
      const items = document.getElementById('context-items')
      const parts = []

      if (state.campus_name) parts.push({ label: state.campus_name, type: 'campus' })
      if (state.year_in_school) parts.push({ label: state.year_in_school, type: 'community' })
      if (state.community_tags?.length) parts.push({ label: state.community_tags.join(', '), type: 'community' })
      if (state.subject_tags?.length) parts.push({ label: state.subject_tags.join(' + '), type: 'subject' })

      if (parts.length > 0) {
        bar.style.display = 'block'
        items.innerHTML = parts.map(p =>
          '<span class="context-item context-' + p.type + '">' + p.label + '</span>'
        ).join('')
      } else {
        bar.style.display = 'none'
      }
    }

    function goToStep(n) {
      document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'))
      document.getElementById('step-' + n).classList.remove('hidden')
      const pct = (n / 4) * 100
      document.getElementById('progress-fill').style.width = pct + '%'
      document.getElementById('progress-label').textContent =
        'Step ' + n + ' of 4'
      updateContextBar()
      if (n === 2 && state.campus_name) {
        document.getElementById("step2-heading").textContent = state.campus_name
        document.querySelector('#step-2 .step-eyebrow').textContent = 'Rate Your Campus'
      }
      if (n === 3) {
        document.getElementById("step3-heading").textContent =
          state.campus_name || "What's the wellbeing experience really like?"
      }
      window.scrollTo(0, 0)
    }

    // ── Step 1 validation ──────────────────────────────────
    function checkStep1() {
      document.getElementById('step1-next').disabled = !state.campus_id
    }

    // ── Campus dropdown (Step 1) ───────────────────────────
    document.getElementById('step1-campus-select')
      .addEventListener('change', e => {
        const opt = e.target.selectedOptions[0]
        state.campus_id   = e.target.value
        state.campus_slug = opt?.dataset.slug || ''
        state.campus_name = opt?.text || ''
        checkStep1()
      })

    // ── Year pills (Step 1) ────────────────────────────────
    document.getElementById('year-select')
      .addEventListener('click', e => {
        const btn = e.target.closest('.bubble')
        if (!btn || btn.disabled) return
        document.querySelectorAll('#year-select .bubble')
          .forEach(b => b.classList.remove('selected'))
        btn.classList.add('selected')
        state.year_in_school = btn.dataset.value
        checkStep1()
      })

    // ── Multi-select bubbles (community tags) ──────────────
    document.getElementById('community-tags')
      .addEventListener('click', e => {
        const btn = e.target.closest('.bubble')
        if (!btn) return
        btn.classList.toggle('selected')
        const v = btn.dataset.value
        if (state.community_tags.includes(v)) {
          state.community_tags = state.community_tags.filter(t => t !== v)
        } else {
          state.community_tags.push(v)
        }
      })

    // ── Single-select archetype gut-check (Step 1) ─────────
    document.getElementById('archetype-select')
      .addEventListener('click', e => {
        const btn = e.target.closest('.archetype-bubble')
        if (!btn) return
        const alreadySelected = btn.classList.contains('selected')
        document.querySelectorAll('#archetype-select .archetype-bubble')
          .forEach(b => b.classList.remove('selected'))
        if (!alreadySelected) {
          btn.classList.add('selected')
          state.archetype_self = btn.dataset.value
        } else {
          state.archetype_self = null
        }
      })

    // ── Step next buttons ──────────────────────────────────
    document.querySelectorAll('.step-next').forEach(btn => {
      btn.addEventListener('click', () => {
        goToStep(parseInt(btn.dataset.next))
      })
    })

    // ── Initialize Step 1 state from server-side campus ───
    checkStep1()

    // ── Single-select subject ──────────────────────────────
    document.getElementById('subject-tags')
      .addEventListener('click', e => {
        const btn = e.target.closest('.bubble')
        if (!btn) return
        const isOverall = btn.dataset.value === 'campus-overall'
        const hasOverall = !!document.querySelector('#subject-tags .bubble[data-value="campus-overall"].selected')
        const already = btn.classList.contains('selected')
        const count = document.querySelectorAll('#subject-tags .bubble.selected').length
        if (already) {
          btn.classList.remove('selected')
        } else if (isOverall) {
          document.querySelectorAll('#subject-tags .bubble').forEach(b => b.classList.remove('selected'))
          btn.classList.add('selected')
        } else if (hasOverall) {
          return
        } else if (count < 2) {
          btn.classList.add('selected')
        }
        state.subject_tags = Array.from(document.querySelectorAll('#subject-tags .bubble.selected')).map(b => b.dataset.value)
        state.subject_tag = state.subject_tags[0] || null
      })
    // ── Rating sliders (Step 2) ────────────────────────────
    const RATING_DIMS   = ['physical','emotional','intellectual','social','spiritual','environmental','occupational','financial']
    const SCALE_LABELS  = ['N/A','No Support','Very Poor','Poor','Below Average','Neutral','Adequate','Good','Very Good','Excellent','Outstanding']
    const ADVERBS       = {
      physical:'Physically', emotional:'Emotionally', intellectual:'Intellectually',
      social:'Socially', spiritual:'Spiritually', financial:'Financially',
      environmental:'Environmental Support', occupational:'Occupational Support'
    }

    function setSliderFill(slider, value) {
      slider.style.setProperty('--fill-pct', (value / 10 * 100) + '%')
    }

    // Initialise all sliders at fill 0
    RATING_DIMS.forEach(dim => setSliderFill(document.getElementById('slider-' + dim), 0))

    RATING_DIMS.forEach(dim => {
      const slider = document.getElementById('slider-' + dim)
      const card   = document.getElementById('card-' + dim)
      const accord = card.querySelector('.rating-accordion')

      // Slider input
      slider.addEventListener('input', function () {
        const val = parseInt(this.value)
        this.dataset.touched = 'true'
        state.ratings[dim] = val
        setSliderFill(this, val)
        document.getElementById('score-' + dim).textContent = val
        document.getElementById('label-' + dim).textContent = ADVERBS[dim] + ' \u2014 ' + SCALE_LABELS[val]
        card.classList.remove('rating-card-error')
        updateRatingProgress()
      })

      // Hover accordion
      card.addEventListener('mouseenter', () => {
        document.querySelectorAll('.rating-accordion').forEach(d => d.removeAttribute('open'))
        accord.setAttribute('open', '')
      })
      card.addEventListener('mouseleave', () => {
        accord.removeAttribute('open')
      })
    })

    // Manual click on summary toggles (overrides hover state)
    document.querySelectorAll('.rating-accordion summary').forEach(summary => {
      summary.addEventListener('click', e => {
        e.preventDefault()
        const det    = summary.parentElement
        const isOpen = det.hasAttribute('open')
        document.querySelectorAll('.rating-accordion').forEach(d => d.removeAttribute('open'))
        if (!isOpen) det.setAttribute('open', '')
      })
    })

    function updateRatingProgress() {
      // Counter: sliders rated above N/A (value > 0)
      const aboveNA = RATING_DIMS.filter(d => state.ratings[d] !== null && state.ratings[d] > 0).length
      document.getElementById('rating-touched-count').textContent = aboveNA
      document.getElementById('rating-progress-fill').style.width = (aboveNA / 8 * 100) + '%'
    }

    function proceedFromStep2() {
      goToStep(3)
    }

    document.getElementById('step2-next').addEventListener('click', () => {
      // Count sliders at 0 or never touched (both treated as N/A)
      const naCount = RATING_DIMS.filter(d => !state.ratings[d] || state.ratings[d] === 0).length
      if (naCount >= 1) {
        const bodyEl = document.getElementById('na-modal-body')
        bodyEl.textContent =
          'You left one or more areas marked N/A. N/A means this service didn\u2019t apply to your experience \u2014 that\u2019s completely fine. Just want to make sure that\u2019s intentional.'
        document.getElementById('na-modal-overlay').style.display = 'flex'
        return
      }
      proceedFromStep2()
    })

    // Modal buttons
    document.getElementById('na-modal-review').addEventListener('click', () => {
      document.getElementById('na-modal-overlay').style.display = 'none'
      const firstNA = RATING_DIMS.find(d => state.ratings[d] === 0)
      if (firstNA) {
        const slider = document.getElementById('slider-' + firstNA)
        slider.focus()
        slider.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    })

    document.getElementById('na-modal-continue').addEventListener('click', () => {
      document.getElementById('na-modal-overlay').style.display = 'none'
      proceedFromStep2()
    })
    // ── Section 1: sentence starter + textarea ─────────────
    const textarea    = document.getElementById('feedback-text')
    const charCurrent = document.getElementById('char-current')
    const submitBtn   = document.getElementById('submit-btn')

    document.getElementById('prompt-select').addEventListener('change', e => {
      const starter = e.target.value
      if (starter) {
        textarea.value = starter
        state.feedback_text = starter
        charCurrent.textContent = starter.length
        textarea.focus()
        textarea.setSelectionRange(starter.length, starter.length)
      }
    })

    textarea.addEventListener('input', () => {
      charCurrent.textContent = textarea.value.length
      state.feedback_text = textarea.value
    })

    // ── Section 2: wish dimension + textarea ────────────────
    const wishTextarea    = document.getElementById('wish-text')
    const wishCharCurrent = document.getElementById('wish-char-current')
    const wishDimSelect   = document.getElementById('wish-dimension')
    const wishDimError    = document.getElementById('wish-dim-error')

    wishDimSelect.addEventListener('change', e => {
      state.wish_dimension = e.target.value || null
      if (state.wish_dimension) {
        wishDimError.style.display = 'none'
        wishDimSelect.classList.remove('input-error')
      }
    })

    wishTextarea.addEventListener('input', () => {
      wishCharCurrent.textContent = wishTextarea.value.length
      state.wish_text = wishTextarea.value
      if (!state.wish_text.trim()) {
        wishDimError.style.display = 'none'
        wishDimSelect.classList.remove('input-error')
      }
    })

    // ── Major input ────────────────────────────────────────
    document.getElementById('major-input').addEventListener('input', e => {
      state.major = e.target.value || null
    })

    // ── Submit ─────────────────────────────────────────────
    submitBtn.addEventListener('click', async () => {
      // Validate Section 2: wish_dimension required if wish_text entered
      if (state.wish_text.trim() && !state.wish_dimension) {
        wishDimError.style.display = 'block'
        wishDimSelect.classList.add('input-error')
        wishDimSelect.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      wishDimError.style.display = 'none'
      wishDimSelect.classList.remove('input-error')

      goToStep(4)

      try {
        const payload = {
          campus_id:      state.campus_id,
          subject_tag:    (state.subject_tags || []).join(','),
          archetype_self: state.archetype_self || null,
          feedback_text:  state.feedback_text  || null,
          wish_text:      state.wish_text.trim()  || null,
          wish_dimension: state.wish_dimension || null,
          year_in_school: state.year_in_school || null,
          major:          state.major          || null,
          community_tags: state.community_tags || []
        }
        ;['physical','emotional','intellectual','social','spiritual','environmental','occupational','financial'].forEach(d => {
          payload['rating_' + d] = (state.ratings[d] != null && state.ratings[d] > 0) ? state.ratings[d] : null
        })
        const res = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
        const data = await res.json()

        if (data.success) {
          window.location.href = '/receipt' +
            '?campus='        + encodeURIComponent(state.campus_name) +
            '&campus_id='     + encodeURIComponent(state.campus_id) +
            '&campus_slug='   + encodeURIComponent(state.campus_slug) +
            '&submitter_id='  + encodeURIComponent(data.submitter_id || '') +
            '&archetype='     + encodeURIComponent(data.archetype_derived || '')
        } else {
          alert('Something went wrong: ' + (data.error || 'Unknown error'))
          goToStep(3)
        }
      } catch (err) {
        alert('Network error. Please try again.')
        goToStep(3)
      }
    })
  </script>
</body>
</html>`
}

function renderReceipt(campusName, campusId, campusSlug, submitterId, dimension, archetype) {
  const campusHref = campusSlug ? `/campus/${campusSlug}` : '/'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thank You — Rate My Campus Wellbeing</title>
  <link rel="canonical" href="https://ratemycampuswellbeing.com/receipt">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://ratemycampuswellbeing.com/receipt">
  <meta property="og:title" content="Thank You — Rate My Campus Wellbeing">
  <meta property="og:site_name" content="Rate My Campus Wellbeing">
  <meta name="twitter:card" content="summary">
  <meta name="robots" content="noindex, nofollow">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="page-receipt">

    <!-- 1. Confirmation block -->
    <div class="receipt-confirm">
      <div class="receipt-check">✓</div>
      <h1 class="receipt-heading">Your voice is in.</h1>
      <p class="receipt-sub">Your experience just made this campus more legible for the next student.</p>
    </div>

    <!-- 2. Contact capture block -->
    <div class="receipt-contact-card">
      <p class="receipt-section-label">Stay in the loop.</p>

      <div class="contact-offer">
        <label class="contact-offer-label" for="rc-email">Get notified when your campus has new ratings.</label>
        <input type="email" id="rc-email" class="contact-email-input" placeholder="your@email.edu" autocomplete="email">
        <div class="freq-pills" id="freq-pills" role="group" aria-label="Notification frequency">
          <button class="freq-pill" data-value="weekly"    type="button">Weekly</button>
          <button class="freq-pill" data-value="monthly"   type="button">Monthly</button>
          <button class="freq-pill" data-value="quarterly" type="button">Quarterly</button>
          <button class="freq-pill" data-value="annually"  type="button">Annually</button>
        </div>
      </div>

      <label class="contact-checkbox-row">
        <input type="checkbox" id="rc-summary">
        <span>Send me a copy of my feedback summary.</span>
      </label>

      <button class="btn-subscribe" id="rc-subscribe-btn" type="button">Subscribe</button>
      <p class="subscribe-status" id="rc-status" aria-live="polite"></p>
    </div>

    <!-- 3. CTA block -->
    <div class="receipt-cta">
      <a href="https://campusmind.org/demo" target="_blank" rel="noopener" class="btn-receipt-primary">
        Find My Resilience Archetype →
      </a>
      <a href="${campusHref}" class="btn-receipt-secondary">
        See How ${campusName ? campusName : 'My Campus'} Scores
      </a>
    </div>

    <!-- 4. Retake link -->
    <div class="receipt-retake">
      <a href="/submit" class="retake-link">Retake Assessment</a>
    </div>

    <!-- 5. Footer -->
    <footer class="receipt-footer">
      <p>© 2026 Rate My Campus Wellbeing · A CampusMind Product</p>
    </footer>

  </div>

  <script>
    const _campusId    = ${JSON.stringify(campusId    || null)}
    const _submitterId = ${JSON.stringify(submitterId || null)}
    let _freq = null

    document.querySelectorAll('.freq-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.freq-pill').forEach(b => b.classList.remove('selected'))
        btn.classList.add('selected')
        _freq = btn.dataset.value
      })
    })

    document.getElementById('rc-subscribe-btn').addEventListener('click', async () => {
      const email  = document.getElementById('rc-email').value.trim()
      const wants  = document.getElementById('rc-summary').checked
      const status = document.getElementById('rc-status')
      const btn    = document.getElementById('rc-subscribe-btn')

      if (!email) {
        status.textContent = 'Please enter your email address.'
        status.className = 'subscribe-status error'
        return
      }

      btn.disabled = true
      btn.textContent = 'Saving...'
      status.textContent = ''

      try {
        const r = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            campus_id:    _campusId    || null,
            submitter_id: _submitterId || null,
            frequency:    _freq        || '',
            wants_summary: wants
          })
        })
        const d = await r.json()
        if (d.success) {
          btn.replaceWith((() => {
            const msg = document.createElement('p')
            msg.className = 'subscribe-status success'
            msg.style.cssText = 'font-size:15px;font-weight:700;margin:0;'
            msg.textContent = "You\u2019re in \u2014 we\u2019ll be in touch."
            return msg
          })())
          status.textContent = ''
        } else {
          btn.disabled = false
          btn.textContent = 'Subscribe'
          status.textContent = 'Something went wrong \u2014 try again.'
          status.className = 'subscribe-status error'
        }
      } catch {
        btn.disabled = false
        btn.textContent = 'Subscribe'
        status.textContent = 'Something went wrong \u2014 try again.'
        status.className = 'subscribe-status error'
      }
    })
  </script>
</body>
</html>`
}

function renderCampusPage(campus, archetypeScores, dimensionScores, submissions, count, ratingAvgs = {}, totalRatingsCount = 0, yearDist = [], campusId = '', archetypeLean = null, wellbeingAvgs = null, wellbeingCount = 0) {
  const dominant = archetypeScores.find(a => a.is_dominant)

  const archLabels = {
    guardian: { emoji: '🏔️', name: 'Architect', dims: 'Academic + Career' },
    warrior:  { emoji: '⚡',  name: 'Warrior',  dims: 'Emotional + Social' },
    healer:   { emoji: '💦',  name: 'Healer',   dims: 'Physical + Financial' },
    guide:    { emoji: '🍃',  name: 'Guide',    dims: 'Spiritual + Environment' }
  }

  const dimOrder = [
    'physical', 'emotional', 'intellectual', 'social',
    'spiritual', 'environmental', 'occupational', 'financial'
  ]
  const dimLabels = {
    physical:      'Physical / Fitness',
    emotional:     'Emotional / Mental',
    intellectual:  'Academic / Intellectual',
    social:        'Social Connection',
    spiritual:     'Spiritual / Direction',
    environmental: 'Environment / Safety',
    occupational:  'Career / Occupational',
    financial:     'Financial'
  }

  const dimColors = {
    physical:      '#D4897A',
    emotional:     '#E8B484',
    intellectual:  '#E8D98A',
    social:        '#94C48A',
    spiritual:     '#90C8D8',
    environmental: '#8A9AC4',
    occupational:  '#A886B8',
    financial:     '#D4A0B8'
  }

  const hasRatings = totalRatingsCount > 0 && Object.values(ratingAvgs).some(v => v !== null)

  const ratingBars = dimOrder.map(dim => {
    const avg = ratingAvgs[dim]
    const pct = avg != null ? (avg / 10 * 100) : 0
    const label = dimLabels[dim]
    const color = dimColors[dim]
    return `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:13px;font-weight:600;color:#333">${label}</span>
        <span style="font-size:13px;font-weight:700;color:#333">${avg != null ? Number(avg).toFixed(1) : 'N/A'}</span>
      </div>
      <div style="background:#eee;border-radius:6px;height:10px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:6px;transition:width .4s"></div>
      </div>
    </div>`
  }).join('')

  const maxDimCount = Math.max(...dimensionScores.map(d => d.submission_count), 1)

  const dimensionBars = dimOrder.map(dim => {
    const score = dimensionScores.find(d => d.dimension_tag === dim)
    const pct = score
      ? Math.round((score.submission_count / maxDimCount) * 100)
      : 0
    return `
    <div class="dim-row">
      <span class="dim-label">${dimLabels[dim]}</span>
      <div class="dim-bar-bg">
        <div class="dim-bar-fill dim-${dim}" style="width:${pct}%"></div>
      </div>
      <span class="dim-count">${score?.submission_count || 0}</span>
    </div>`
  }).join('')

  const archetypeCards = ['guardian','warrior','guide','healer'].map(key => {
    const score = archetypeScores.find(a => a.archetype_tag === key)
    const label = archLabels[key]
    const pct   = score?.pct_of_total || 0
    const isDom = score?.is_dominant || false
    return `
    <div class="arch-card arch-${key} ${isDom ? 'dominant' : ''}">
      <div class="arch-card-top">
        <span class="arch-emoji">${label.emoji}</span>
        <span class="arch-name">${label.name}</span>
        ${isDom ? '<span class="dominant-badge">Leading</span>' : ''}
      </div>
      <div class="arch-dims">${label.dims}</div>
      <div class="arch-bar-bg">
        <div class="arch-bar-fill" style="width:${pct}%"></div>
      </div>
      <span class="arch-pct">${pct.toFixed(0)}%</span>
    </div>`
  }).join('')

  const feedItems = submissions.map(s => {
    const communityTags = s.submitters?.community_tags || []
    const subjectLabel = s.subject_tag ? s.subject_tag.replace(/-/g,' ') : ''
    const bodyText = escapeHtml((s.feedback_text || s.guidance_text || '').trim())
    return [
      '<div class="feed-entry" data-dim="' + (s.dimension_tag||'') + '" data-subject="' + escapeHtml(s.subject_tag||'') + '">',
      '<div class="feed-meta">',
      s.year_in_school ? '<span class="meta-pill">' + s.year_in_school + ' year</span>' : '',
      s.major ? '<span class="meta-pill">' + escapeHtml(s.major) + '</span>' : '',
      communityTags.length ? '<span class="meta-pill">' + communityTags.join(', ') + '</span>' : '',
      '</div>',
      '<p class="feed-text">' + bodyText + '</p>',
      '<div class="feed-tags">',
      subjectLabel ? '<span class="feed-tag subject-tag">' + escapeHtml(subjectLabel) + '</span>' : '',
      '</div></div>'
    ].join('')
  }).join('')

  const yearPills = yearDist.length > 0 ? `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
      <button class="year-pill active" data-year="">All</button>
      ${yearDist.map(y => `<button class="year-pill" data-year="${y}">${y} year</button>`).join('')}
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${campus.name} Wellbeing — Rate My Campus Wellbeing</title>
  <link rel="canonical" href="https://ratemycampuswellbeing.com/campus/${campus.slug}">
  <meta name="description" content="Student wellbeing scores and reviews for ${campus.name}. See how students rate mental health, social connection, academic pressure, and more.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://ratemycampuswellbeing.com/campus/${campus.slug}">
  <meta property="og:title" content="${campus.name} Wellbeing — Rate My Campus Wellbeing">
  <meta property="og:description" content="Student wellbeing scores and reviews for ${campus.name}.">
  <meta property="og:site_name" content="Rate My Campus Wellbeing">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${campus.name} Wellbeing — Rate My Campus Wellbeing">
  <meta name="twitter:description" content="Student wellbeing scores and reviews for ${campus.name}.">
  <meta name="robots" content="index, follow">
  <link rel="stylesheet" href="/style.css">
  <style>
    .year-pill{padding:6px 14px;border-radius:20px;border:1.5px solid #ccc;background:#fff;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}
    .year-pill.active{background:#3a86ff;border-color:#3a86ff;color:#fff}
    .radar-toggle{padding:6px 12px;border-radius:20px;border:1.5px solid #ccc;background:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap}
    .radar-toggle.active{background:#1a1a2e;border-color:#1a1a2e;color:#fff}
    #insights-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
    @media(max-width:640px){#insights-row{grid-template-columns:1fr}}
    .radar-year-sel{padding:5px 10px;border-radius:8px;border:1.5px solid #ddd;font-size:12px;color:#555;background:#fff;margin-bottom:12px}
  </style>
</head>
<body>
  <div class="page-campus">
    <header class="nav">
      <a href="/" class="nav-logo">Rate My Campus Wellbeing</a>
      <a href="/submit?campus=${campus.slug}" class="btn-primary btn-small">
        Rate This Campus →
      </a>
    </header>

    <main class="campus-main">
      <a href="/" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#4A6FA5;text-decoration:none;margin-bottom:16px;opacity:.85">← Back</a>
      <div class="campus-header">
        <div>
          <h1>${campus.name}</h1>
          <p class="campus-meta">
            ${campus.system} System · ${campus.city || ''}
          </p>
        </div>
      </div>

      ${!hasRatings && count === 0 && wellbeingCount < 1 ? `
      <div class="empty-state">
        <p>No reviews yet for ${campus.name}.</p>
        <a href="/submit?campus=${campus.slug}" class="btn-primary">
          Be the first to share →
        </a>
      </div>` : `

      ${hasRatings ? `
      <div class="scores-panel" style="margin-bottom:24px;position:relative">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:2px">
          <p class="panel-label" style="margin:0">Campus Support Ratings</p>
          <span style="font-size:11px;color:#aaa;border:1px solid #e0e0e0;border-radius:20px;padding:2px 10px;white-space:nowrap;margin-left:8px">${totalRatingsCount} rating${totalRatingsCount === 1 ? '' : 's'}</span>
        </div>
        <p style="font-size:11px;color:#aaa;margin:4px 0 14px">Scale: 0 = N/A &nbsp;·&nbsp; 1 = No Support &nbsp;·&nbsp; 5 = Neutral &nbsp;·&nbsp; 7 = Good &nbsp;·&nbsp; 10 = Outstanding</p>
        ${yearPills}
        <div id="ratings-chart">
          ${ratingBars}
        </div>
        <p id="ratings-count" style="font-size:12px;color:#aaa;margin:8px 0 4px">Based on ${totalRatingsCount} rating${totalRatingsCount === 1 ? '' : 's'}</p>
        <p style="font-size:11px;color:#aaa;margin:4px 0 0">Source: Rate My Campus Wellbeing · ratemycampuswellbeing.com</p>
      </div>` : ''}

      ${(() => {
        // ── Radar section (left) ───────────────────────────────
        const hasRmcw      = totalRatingsCount >= 1
        const hasWellbeing = wellbeingCount >= 1

        const yearOpts = yearDist.map(y =>
          '<option value="' + y + '">' + y + ' year</option>'
        ).join('')

        let radarBody
        if (!hasRmcw && !hasWellbeing) {
          radarBody = '<p style="font-size:13px;color:#888;padding:24px 0;text-align:center">Not enough data yet for this campus — check back as more students share their experience.</p>'
        } else {
          // Per-layer partial-data note
          let note = ''
          if (hasRmcw && !hasWellbeing) {
            note = '<p style="font-size:11px;color:#aaa;margin:8px 0 0">Student Wellbeing data not yet available for this campus &nbsp;·&nbsp; <a href="https://campusmind.org/demo" target="_blank" rel="noopener" style="color:#ca8a04;text-decoration:none;font-weight:600">Be the first → campusmind.org/demo</a></p>'
          } else if (!hasRmcw && hasWellbeing) {
            note = '<p style="font-size:11px;color:#aaa;margin:8px 0 0">Campus Support data not yet available &nbsp;·&nbsp; <a href="/submit?campus=${campus.slug}" style="color:#ef4444;text-decoration:none;font-weight:600">Rate This Campus →</a></p>'
          }

          // Per-layer citations
          const citRmcw     = '<span><span style="color:#ef4444;font-weight:700">●</span> Campus Support · Rate My Campus Wellbeing · ratemycampuswellbeing.com</span>'
          const citWellbeing= '<span><span style="color:#ca8a04;font-weight:700">●</span> Student Wellbeing · CampusMind · campusmind.org/demo</span>'
          const citations   = '<div style="display:flex;gap:16px;margin-top:10px;flex-wrap:wrap;font-size:10px;color:#aaa;line-height:1.6">' +
            (hasRmcw ? citRmcw : '') +
            (hasWellbeing ? citWellbeing : '') +
            '</div>'

          radarBody =
            '<select id="radar-year-select" class="radar-year-sel">' +
              '<option value="">All Years</option>' + yearOpts +
            '</select>' +
            '<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">' +
              '<button class="radar-toggle active" data-mode="both">Show Both</button>' +
              '<button class="radar-toggle" data-mode="campus">Campus Only</button>' +
              '<button class="radar-toggle" data-mode="students">Students Only</button>' +
            '</div>' +
            '<div id="radar-svg-container" style="min-height:200px"></div>' +
            note +
            citations
        }

        const radarPanel =
          '<div class="scores-panel" style="margin:0">' +
            '<p class="panel-label">Planning vs Wellbeing</p>' +
            '<p style="font-size:12px;color:#888;margin:-4px 0 14px">How the campus rates vs how students are doing.</p>' +
            radarBody +
          '</div>'

        // ── Archetype lean section (right) ─────────────────────
        const leanPanel =
          '<div class="scores-panel" style="margin:0">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">' +
              '<p class="panel-label" style="margin:0">Campus Resilience Lean</p>' +
              '<div style="display:flex;gap:4px">' +
                '<button class="lean-toggle active" data-mode="self" onclick="switchLeanMode(\'self\')" style="padding:5px 12px;border-radius:20px;border:1.5px solid #3a86ff;background:#3a86ff;color:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s">Self-Reported</button>' +
                '<button class="lean-toggle" data-mode="derived" onclick="switchLeanMode(\'derived\')" style="padding:5px 12px;border-radius:20px;border:1.5px solid #ccc;background:#fff;color:#666;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s">Rating-Derived</button>' +
              '</div>' +
            '</div>' +
            '<div id="lean-grid"></div>' +
            '<p id="lean-interpretation" style="font-size:12px;color:#555;margin:10px 0 4px"></p>' +
            '<p id="archetype-count" style="font-size:12px;color:#aaa;margin:4px 0 0"></p>' +
          '</div>'

        return '<div id="insights-row">' + radarPanel + leanPanel + '</div>'
      })()}

      <div class="feed-section">
        <div class="feed-header">
          <p class="panel-label">Student voices</p>
          <div class="community-filter-wrap">
            <select id="subject-filter-select">
              <option value="">+ Filter by subject</option>
              <option value="campus-overall">Campus Overall</option>
              <option value="department-major">Department/Major</option>
              <option value="facility">Facility</option>
              <option value="program">Program</option>
              <option value="resource">Resource</option>
              <option value="transition-experience">Transition Experience</option>
            </select>
            <button class="chip" id="filter-clear-subject" style="display:none">Clear filter</button>
          </div>
        </div>
        <div id="feed">
          ${feedItems || '<p class="empty-feed">No student voices yet.</p>'}
        </div>
      </div>
      `}

      <div style="text-align:center;padding:32px 16px 8px">
        <p style="font-size:12px;color:#aaa;margin:0 0 18px;letter-spacing:.02em">Your experience helps the next student.</p>
        <div style="display:flex;flex-direction:column;gap:12px;max-width:340px;margin:0 auto">
          <a href="/submit?campus=${campus.slug}"
             style="display:block;background:#4A6FA5;color:#fff;font-size:15px;font-weight:700;text-decoration:none;text-align:center;padding:0 28px;height:48px;line-height:48px;border-radius:100px">
            Rate This Campus →
          </a>
          <a href="https://campusmind.org/demo" target="_blank" rel="noopener"
             style="display:block;background:transparent;color:#4A6FA5;font-size:15px;font-weight:700;text-decoration:none;text-align:center;padding:0 28px;height:48px;line-height:48px;border-radius:100px;border:2px solid #4A6FA5">
            Check In On Your Wellbeing →
          </a>
        </div>
      </div>
    </main>

    <footer class="receipt-footer">
      <p>© 2026 Rate My Campus Wellbeing · A CampusMind Product</p>
    </footer>
  </div>

  <script>
    const _campusId  = ${JSON.stringify(campusId)}
    const _dimColors = ${JSON.stringify({
      physical:'#D4897A', emotional:'#E8B484', intellectual:'#E8D98A',
      social:'#94C48A', spiritual:'#90C8D8', environmental:'#8A9AC4',
      occupational:'#A886B8', financial:'#D4A0B8'
    })}
    const _dimLabels = ${JSON.stringify({
      physical:'Physical / Fitness', emotional:'Emotional / Mental',
      intellectual:'Academic / Intellectual', social:'Social Connection',
      spiritual:'Spiritual / Direction', environmental:'Environment / Safety',
      occupational:'Career / Occupational', financial:'Financial'
    })}
    const _dimOrder  = ['physical','emotional','intellectual','social','spiritual','environmental','occupational','financial']

    // ── Year filter ────────────────────────────────────────
    document.querySelectorAll('.year-pill').forEach(btn => {
      btn.addEventListener('click', async () => {
        document.querySelectorAll('.year-pill').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        const year = btn.dataset.year
        try {
          const url = '/api/campus-ratings?campus_id=' + encodeURIComponent(_campusId) + (year ? '&year=' + encodeURIComponent(year) : '')
          const r = await fetch(url)
          const d = await r.json()
          renderChart(d.avgs, d.count)
          _leanRatCount = d.count
          if (d.archCounts) {
            const at = Object.values(d.archCounts).reduce((a,b)=>a+b,0)
            const ap = {}
            for (const [k,v] of Object.entries(d.archCounts)) ap[k] = at > 0 ? Math.round(v/at*100) : 0
            _leanSelf = { counts: d.archCounts, total: at, pcts: ap, dominant: at >= 3 ? Object.entries(d.archCounts).reduce((a,b)=>b[1]>a[1]?b:a)[0] : null }
          }
          _leanDerived = computeRatingDerived(d.avgs)
          renderLeanGrid(_leanMode)
        } catch(e) { console.error('Year filter error', e) }
      })
    })

    function renderChart(avgs, count) {
      const chart = document.getElementById('ratings-chart')
      if (!chart) return
      chart.innerHTML = _dimOrder.map(dim => {
        const avg = avgs[dim]
        const pct = avg !== null && avg !== undefined ? (avg / 10 * 100) : 0
        return '<div style="margin-bottom:10px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
            '<span style="font-size:13px;font-weight:600;color:#333">' + _dimLabels[dim] + '</span>' +
            '<span style="font-size:13px;font-weight:700;color:#333">' + (avg !== null && avg !== undefined ? Number(avg).toFixed(1) : 'N/A') + '</span>' +
          '</div>' +
          '<div style="background:#eee;border-radius:6px;height:10px;overflow:hidden">' +
            '<div style="width:' + pct + '%;height:100%;background:' + _dimColors[dim] + ';border-radius:6px;transition:width .4s"></div>' +
          '</div></div>'
      }).join('')
      const countEl = document.getElementById('ratings-count')
      if (countEl) countEl.textContent = 'Based on ' + count + ' rating' + (count === 1 ? '' : 's')
    }

    // ── Radar chart ────────────────────────────────────────
    const _campusSlug    = ${JSON.stringify(campus.slug)}
    const _campusName    = ${JSON.stringify(campus.name)}
    const _campusCity    = ${JSON.stringify(campus.city || '')}
    let   _radarPlanning = ${JSON.stringify(totalRatingsCount >= 1 ? { ...ratingAvgs, count: totalRatingsCount } : null)}
    let   _radarSocial   = ${JSON.stringify(wellbeingCount >= 1 ? { ...wellbeingAvgs, count: wellbeingCount } : null)}
    let   _radarMode     = 'both'
    let   _radarYear     = ''
    // ── Lean data ───────────────────────────────────────────
    let _leanSelf    = ${JSON.stringify(archetypeLean)}
    let _leanDerived = null
    let _leanMode    = 'self'
    let _leanRatCount = ${totalRatingsCount}

    function buildRadarSVG(l1, l2, mode) {
      const N = 8, W = 320, H = 320, cx = W/2, cy = H/2, R = 105, LR = 138
      const order  = ['physical','emotional','intellectual','social','spiritual','environmental','occupational','financial']
      const labels = ['Physical','Emotional','Intellectual','Social','Spiritual','Environ.','Career','Financial']
      function ang(i) { return (i / N) * Math.PI * 2 - Math.PI / 2 }
      function ptStr(r, i) {
        const a = ang(i)
        return (cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1)
      }
      function ringPts(frac) {
        return Array.from({length: N}, (_, i) => ptStr(R * frac, i)).join(' ')
      }
      let s = '<svg viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block;overflow:visible">'
      // Rings
      for (let v = 2; v <= 10; v += 2) {
        s += '<polygon points="' + ringPts(v/10) + '" fill="none" stroke="#e8e8e8" stroke-width="0.8"/>'
        s += '<text x="' + (cx+3) + '" y="' + (cy - R*(v/10) - 3).toFixed(1) + '" font-size="7.5" fill="#c8c8c8" text-anchor="start">' + v + '</text>'
      }
      // Axes + labels
      for (let i = 0; i < N; i++) {
        const a = ang(i)
        const ex = (cx + R * Math.cos(a)).toFixed(1), ey = (cy + R * Math.sin(a)).toFixed(1)
        const lx = (cx + LR * Math.cos(a)).toFixed(1), ly = (cy + LR * Math.sin(a)).toFixed(1)
        s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + ex + '" y2="' + ey + '" stroke="#e8e8e8" stroke-width="0.8"/>'
        const anch = Math.abs(Math.cos(a)) < 0.12 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end')
        const dyVal = Math.sin(a) > 0.5 ? '10' : (Math.sin(a) < -0.5 ? '0' : '4')
        s += '<text x="' + lx + '" y="' + ly + '" dy="' + dyVal + '" font-size="9" fill="#555" text-anchor="' + anch + '" font-family="system-ui,sans-serif">' + labels[i] + '</text>'
      }
      // Data polygon helper
      function poly(avgs, color, op) {
        if (!avgs) return ''
        const pts = order.map((d, i) => {
          const v = avgs[d] != null ? Number(avgs[d]) : 0
          const a = ang(i)
          return (cx + (v/10)*R*Math.cos(a)).toFixed(1) + ',' + (cy + (v/10)*R*Math.sin(a)).toFixed(1)
        }).join(' ')
        return '<polygon points="' + pts + '" fill="' + color + '" fill-opacity="' + op + '" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round"/>'
      }
      if (mode !== 'students') s += poly(l1, '#ef4444', 0.13)
      if (mode !== 'campus')   s += poly(l2, '#ca8a04', 0.13)
      s += '</svg>'
      return s
    }

    function updateRadar() {
      const container = document.getElementById('radar-svg-container')
      if (!container) return
      const l1 = (_radarMode !== 'students' && _radarPlanning) ? _radarPlanning : null
      const l2 = (_radarMode !== 'campus'   && _radarSocial)   ? _radarSocial   : null
      container.innerHTML = buildRadarSVG(l1, l2, _radarMode)
    }

    // Radar toggle buttons
    document.querySelectorAll('.radar-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.radar-toggle').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        _radarMode = btn.dataset.mode
        updateRadar()
      })
    })

    // Radar year filter
    const radarYearSel = document.getElementById('radar-year-select')
    if (radarYearSel) {
      radarYearSel.addEventListener('change', async (e) => {
        _radarYear = e.target.value
        try {
          const url = '/api/campus-radar?campus_id=' + encodeURIComponent(_campusId) +
            '&campus_slug=' + encodeURIComponent(_campusSlug) +
            '&campus_name=' + encodeURIComponent(_campusName) +
            '&campus_city=' + encodeURIComponent(_campusCity) +
            (_radarYear ? '&year=' + encodeURIComponent(_radarYear) : '')
          const resp = await fetch(url)
          const d    = await resp.json()
          _radarPlanning = d.planning || null
          _radarSocial   = d.social   || null
          updateRadar()
        } catch(err) { console.error('Radar year filter error', err) }
      })
    }

    // Initial draw
    updateRadar()

    // ── Lean grid ───────────────────────────────────────────
    const _leanMeta = {
      guardian: { emoji: '🏔️', name: 'Architect', phase: 'Academic + Career',       color: '#C4856A' },
      warrior:  { emoji: '⚡',  name: 'Warrior',   phase: 'Emotional + Social',      color: '#4A5080' },
      guide:    { emoji: '🍃',  name: 'Guide',     phase: 'Spiritual + Environment', color: '#C8B84A' },
      healer:   { emoji: '💦',  name: 'Healer',    phase: 'Physical + Financial',    color: '#7BA898' }
    }

    function computeRatingDerived(avgs) {
      if (!avgs) return null
      function avg2(a, b) {
        const vals = [avgs[a], avgs[b]].filter(v => v != null)
        return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null
      }
      const scores = {
        guardian: avg2('intellectual', 'occupational'),
        warrior:  avg2('emotional',    'social'),
        healer:   avg2('physical',     'financial'),
        guide:    avg2('spiritual',    'environmental')
      }
      const total = Object.values(scores).filter(v => v != null).reduce((a, b) => a + b, 0)
      if (total === 0) return null
      const pcts = {}
      for (const [k, v] of Object.entries(scores)) pcts[k] = v != null ? Math.round(v / total * 100) : 0
      const dominant = Object.entries(pcts).reduce((a, b) => b[1] > a[1] ? b : a)[0]
      return { scores, pcts, dominant }
    }

    function renderLeanGrid(mode) {
      const gridEl   = document.getElementById('lean-grid')
      const interpEl = document.getElementById('lean-interpretation')
      const countEl  = document.getElementById('archetype-count')
      if (!gridEl) return
      const data = mode === 'self' ? _leanSelf : _leanDerived
      if (mode === 'self') {
        const n = data ? data.total : 0
        if (!data || data.total < 3) {
          gridEl.innerHTML = ''
          if (interpEl) interpEl.textContent = ''
          if (countEl) countEl.textContent = n > 0 ? 'Not enough responses yet to determine a campus lean.' : 'No self-reported archetype responses yet.'
          return
        }
        if (countEl) countEl.textContent = 'Based on ' + n + ' archetype response' + (n !== 1 ? 's' : '')
      } else {
        if (!data) {
          gridEl.innerHTML = ''
          if (interpEl) interpEl.textContent = ''
          if (countEl) countEl.textContent = 'Not enough rating data yet.'
          return
        }
        if (countEl) countEl.textContent = 'Based on ' + _leanRatCount + ' rating' + (_leanRatCount !== 1 ? 's' : '')
      }
      const cards = ['guardian', 'warrior', 'guide', 'healer'].map(key => {
        const m = _leanMeta[key], pct = data.pcts[key] || 0, isDom = data.dominant === key
        return '<div style="background:' + m.color + '1a;border:2px solid ' + (isDom ? m.color : '#e5e5e5') + ';border-radius:12px;padding:14px;position:relative">' +
          (isDom ? '<span style="position:absolute;top:8px;right:8px;background:' + m.color + ';color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px">Leading</span>' : '') +
          '<div style="font-size:24px;margin-bottom:3px">' + m.emoji + '</div>' +
          '<div style="font-size:14px;font-weight:800;color:#1a1a2e">' + m.name + '</div>' +
          '<div style="font-size:11px;color:#666;margin:2px 0 6px">' + m.phase + '</div>' +
          '<div style="font-size:20px;font-weight:800;color:' + m.color + '">' + pct + '%</div>' +
          '</div>'
      }).join('')
      gridEl.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' + cards + '</div>'
      const dom = data.dominant, cn = _campusName
      const interps = {
        self: {
          guardian: cn + ' students see themselves as Architects — planners who prepare before problems arise.',
          warrior:  cn + ' students see themselves as Warriors — activated by pressure and challenge.',
          healer:   cn + ' students see themselves as Healers — focused on recovery and coming back stronger.',
          guide:    cn + ' students see themselves as Guides — pattern-seekers who anticipate what comes next.'
        },
        derived: {
          guardian: cn + ' ratings suggest an Architect campus — strong in academic and career support.',
          warrior:  cn + ' ratings suggest a Warrior campus — strongest in emotional and social support.',
          healer:   cn + ' ratings suggest a Healer campus — strongest in physical and financial support.',
          guide:    cn + ' ratings suggest a Guide campus — strongest in spiritual and environmental support.'
        }
      }
      if (interpEl) interpEl.textContent = dom ? (interps[mode]?.[dom] || '') : ''
    }

    function switchLeanMode(mode) {
      _leanMode = mode
      document.querySelectorAll('.lean-toggle').forEach(btn => {
        const on = btn.dataset.mode === mode
        btn.classList.toggle('active', on)
        btn.style.background  = on ? '#3a86ff' : '#fff'
        btn.style.color       = on ? '#fff'    : '#666'
        btn.style.borderColor = on ? '#3a86ff' : '#ccc'
      })
      renderLeanGrid(mode)
    }

    // Initial lean draw
    _leanDerived = computeRatingDerived(_radarPlanning)
    renderLeanGrid('self')

    // ── Subject filter ─────────────────────────────────────
    let _activeSubject = ''

    function applySubjectFilter() {
      document.querySelectorAll('.feed-entry').forEach(entry => {
        if (!_activeSubject) { entry.style.display = ''; return }
        entry.style.display = (entry.dataset.subject || '') === _activeSubject ? '' : 'none'
      })
      const clearBtn = document.getElementById('filter-clear-subject')
      if (clearBtn) clearBtn.style.display = _activeSubject ? '' : 'none'
    }

    const subjectSel = document.getElementById('subject-filter-select')
    if (subjectSel) {
      subjectSel.addEventListener('change', e => {
        _activeSubject = e.target.value
        applySubjectFilter()
      })
    }

    const clearSubject = document.getElementById('filter-clear-subject')
    if (clearSubject) {
      clearSubject.addEventListener('click', () => {
        _activeSubject = ''
        if (subjectSel) subjectSel.value = ''
        applySubjectFilter()
      })
    }
  </script>
</body>
</html>`
}

function renderAdminLogin(errorMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login — RMCW</title>
  <meta name="robots" content="noindex, nofollow">
  <link rel="stylesheet" href="/style.css">
  <style>
    body{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa;margin:0}
    .login-card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px 36px;width:100%;max-width:360px}
    .login-card h1{font-size:22px;font-weight:700;margin:0 0 6px;color:#1a1a2e}
    .login-card p{font-size:13px;color:#888;margin:0 0 24px}
    .login-card input{width:100%;box-sizing:border-box;padding:10px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:12px}
    .login-card input:focus{outline:none;border-color:#3a86ff}
    .login-card button{width:100%;padding:11px;background:#1a1a2e;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
    .login-error{color:#dc2626;font-size:13px;margin-bottom:12px;background:#fee2e2;padding:8px 12px;border-radius:6px}
  </style>
</head>
<body>
  <div class="login-card">
    <h1>RMCW Admin</h1>
    <p>Enter your admin password to continue.</p>
    ${errorMsg ? '<p class="login-error">' + escapeHtml(errorMsg) + '</p>' : ''}
    <form method="POST" action="/burkmin/login">
      <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
      <button type="submit">Sign In →</button>
    </form>
  </div>
</body>
</html>`
}

function renderAdminDashboard(normal, archived, deleted, total) {
  const RATING_KEYS = [
    ['rating_physical','Phy'],['rating_emotional','Emo'],['rating_intellectual','Int'],
    ['rating_social','Soc'],['rating_spiritual','Spi'],['rating_environmental','Env'],
    ['rating_occupational','Occ'],['rating_financial','Fin']
  ]

  function ratingColor(v) {
    if (v == null) return '#e5e7eb'
    if (v <= 3)  return '#fca5a5'
    if (v <= 5)  return '#fde68a'
    if (v <= 7)  return '#86efac'
    return '#4ade80'
  }

  function inlineFlag(type, id, flagged, reason) {
    const btnId   = 'flag-btn-'  + type + '-' + id
    const formId  = 'flag-form-' + type + '-' + id
    const inputId = 'flag-inp-'  + type + '-' + id
    if (flagged) {
      return [
        '<div style="background:#fef3c7;border-radius:6px;padding:6px 10px;margin:4px 0 6px;display:flex;align-items:flex-start;gap:8px">',
        '<span style="font-size:11px;color:#92400e;flex:1">⚑ Flagged' + (reason ? ': ' + escapeHtml(reason) : '') + '</span>',
        '<button style="padding:2px 8px;border-radius:5px;border:1.5px solid #16a34a;background:#f0fdf4;color:#16a34a;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap" ',
        'onclick="doUnflag(\u0027' + type + '\u0027,\u0027' + id + '\u0027)">↩ Unflag</button>',
        '</div>'
      ].join('')
    }
    return [
      '<div id="' + btnId + '" style="display:inline-block;margin:4px 0 2px">',
      '<button class="btn-flag" style="font-size:11px;padding:3px 9px" ',
      'onclick="showFlagForm(\u0027' + type + '\u0027,\u0027' + id + '\u0027)">⚑ Flag ' + (type === 'fb' ? 'feedback' : 'guidance') + '</button>',
      '</div>',
      '<span id="' + formId + '" style="display:none;align-items:center;gap:4px;margin:4px 0 2px">',
      '<input id="' + inputId + '" type="text" placeholder="Reason…" ',
      'style="padding:3px 8px;border:1.5px solid #f59e0b;border-radius:6px;font-size:12px;width:160px">',
      '<button style="padding:3px 9px;border-radius:5px;border:none;background:#f59e0b;color:#fff;font-size:11px;font-weight:600;cursor:pointer" ',
      'onclick="confirmFlag(\u0027' + type + '\u0027,\u0027' + id + '\u0027)">OK</button>',
      '<button style="padding:3px 7px;border-radius:5px;border:1.5px solid #ccc;background:#fff;color:#555;font-size:11px;cursor:pointer" ',
      'onclick="cancelFlag(\u0027' + type + '\u0027,\u0027' + id + '\u0027)">✕</button>',
      '</span>'
    ].join('')
  }

  function buildCard(s, mode) {
    const communityTags = s.communities ? s.communities.split(',').map(t => t.trim()).filter(Boolean) : []
    const dt = new Date(s.created_at)
    const dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' })
    const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', hour12: true })
    const timestamp = dateStr + ' · ' + timeStr + ' PT'

    const ratingPills = RATING_KEYS.map(([col, label]) => {
      const v = s[col]
      return '<span style="display:inline-flex;align-items:center;gap:2px;padding:2px 6px;border-radius:10px;font-size:11px;font-weight:600;background:' +
        ratingColor(v) + ';color:#1a1a2e">' + label + (v != null ? ':' + v : ':–') + '</span>'
    }).join('')

    const fbBlock = s.feedback_text ? [
      '<div style="margin:6px 0 4px;padding:8px 10px;background:' + (s.feedback_flagged ? '#fffbeb' : '#f9fafb') + ';border-radius:6px;border:1px solid ' + (s.feedback_flagged ? '#fde68a' : '#e5e7eb') + '">',
      '<p style="margin:0 0 4px;font-size:13px;color:#1a1a2e">' + escapeHtml(s.feedback_text) + '</p>',
      mode !== 'deleted' ? inlineFlag('fb', s.id, s.feedback_flagged, s.feedback_flag_reason) : '',
      '</div>'
    ].join('') : ''

    const guBlock = s.guidance_text ? [
      '<div style="margin:4px 0 4px;padding:8px 10px;background:' + (s.guidance_flagged ? '#fffbeb' : '#f9fafb') + ';border-radius:6px;border:1px solid ' + (s.guidance_flagged ? '#fde68a' : '#e5e7eb') + '">',
      '<p style="margin:0 0 4px;font-size:13px;color:#6b7280;font-style:italic">' + escapeHtml(s.guidance_text) + '</p>',
      mode !== 'deleted' ? inlineFlag('gu', s.id, s.guidance_flagged, s.guidance_flag_reason) : '',
      '</div>'
    ].join('') : ''

    let actions = ''
    if (mode === 'normal') {
      actions = [
        '<button style="padding:5px 12px;border-radius:6px;border:1.5px solid #6b7280;background:#f3f4f6;color:#374151;font-size:12px;font-weight:600;cursor:pointer" ',
        'onclick="doArchive(\u0027' + s.id + '\u0027)">🗃 Archive</button>',
        '<button class="btn-delete" onclick="doDelete(\u0027' + s.id + '\u0027)">🗑 Delete</button>'
      ].join('')
    } else if (mode === 'archived') {
      actions = [
        '<button style="padding:5px 12px;border-radius:6px;border:1.5px solid #16a34a;background:#f0fdf4;color:#16a34a;font-size:12px;font-weight:600;cursor:pointer" ',
        'onclick="doUnarchive(\u0027' + s.id + '\u0027)">↩ Unarchive</button>',
        '<button class="btn-delete" onclick="doDelete(\u0027' + s.id + '\u0027)">🗑 Delete</button>'
      ].join('')
    } else {
      actions = [
        '<button style="padding:5px 12px;border-radius:6px;border:1.5px solid #16a34a;background:#f0fdf4;color:#16a34a;font-size:12px;font-weight:600;cursor:pointer" ',
        'onclick="doRestore(\u0027' + s.id + '\u0027)">↩ Restore</button>'
      ].join('')
    }

    const campusName = escapeHtml(s.campuses?.name || 'Unknown')
    const yearVal    = escapeHtml(s.year_in_school || '')

    return [
      '<div class="admin-row" id="row-' + s.id + '" data-campus="' + campusName + '" data-year="' + yearVal + '">',
      '<div class="admin-meta" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:6px">',
      '<strong style="font-size:14px">' + campusName + '</strong>',
      s.year_in_school ? '<span class="meta-pill">' + escapeHtml(s.year_in_school) + ' year</span>' : '',
      communityTags.map(t => '<span class="meta-pill">' + escapeHtml(t) + '</span>').join(''),
      s.subject_tag ? '<span class="meta-pill" style="background:#dbeafe;color:#1e40af">' + escapeHtml(s.subject_tag) + '</span>' : '',
      '<span class="meta-date" style="margin-left:auto;font-size:11px;color:#9ca3af;white-space:nowrap">' + timestamp + '</span>',
      '</div>',
      '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">' + ratingPills + '</div>',
      fbBlock,
      guBlock,
      '<div class="admin-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">' + actions + '</div>',
      '</div>'
    ].join('')
  }

  const normalHtml   = normal.length   === 0 ? '<p class="empty-state" style="padding:16px 0">No submissions yet.</p>'   : normal.map(s   => buildCard(s, 'normal')).join('')
  const archivedHtml = archived.length === 0 ? '<p class="empty-state" style="padding:16px 0">No archived submissions.</p>' : archived.map(s => buildCard(s, 'archived')).join('')
  const deletedHtml  = deleted.length  === 0 ? '<p class="empty-state" style="padding:16px 0">No deleted submissions.</p>'  : deleted.map(s  => buildCard(s, 'deleted')).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard — RMCW</title>
  <meta name="robots" content="noindex, nofollow">
  <link rel="stylesheet" href="/style.css">
  <style>
    .admin-tab-bar{display:flex;gap:0;border-bottom:2px solid #e5e7eb;margin-bottom:20px;overflow-x:auto}
    .admin-tab{padding:10px 20px;font-size:14px;font-weight:600;color:#6b7280;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s}
    .admin-tab:hover{color:#1a1a2e}
    .admin-tab.active{color:#3a86ff;border-bottom-color:#3a86ff}
    .admin-filter-bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
    .admin-filter-bar select{padding:7px 12px;border:1.5px solid #ddd;border-radius:8px;font-size:13px;background:#fff;color:#374151;cursor:pointer;min-width:160px}
    .tab-panel{display:none}
    .tab-panel.active{display:block}
  </style>
</head>
<body>
  <div class="page-admin">
    <header class="nav">
      <span class="nav-logo">RMCW Admin</span>
      <a href="/burkmin/logout" style="margin-left:auto;font-size:13px;color:#888;text-decoration:none;padding:5px 12px;border:1.5px solid #e5e7eb;border-radius:6px">Log out</a>
    </header>
    <main class="admin-main">

      <div class="admin-tab-bar">
        <button class="admin-tab active" data-tab="normal"   onclick="switchTab('normal')"  >All Submissions (<span id="count-normal">${normal.length}</span>)</button>
        <button class="admin-tab"        data-tab="archived" onclick="switchTab('archived')" >Archived (<span id="count-archived">${archived.length}</span>)</button>
        <button class="admin-tab"        data-tab="deleted"  onclick="switchTab('deleted')"  >Deleted (<span id="count-deleted">${deleted.length}</span>)</button>
      </div>

      <div class="admin-filter-bar">
        <select id="filter-campus" onchange="applyFilters()">
          <option value="">Filter by Campus</option>
        </select>
        <select id="filter-year" onchange="applyFilters()">
          <option value="">Filter by Year</option>
          <option value="1st">1st year</option>
          <option value="2nd">2nd year</option>
          <option value="3rd">3rd year</option>
          <option value="4th">4th year</option>
          <option value="5th+">5th+ year</option>
          <option value="grad">Grad</option>
          <option value="alumni">Alumni</option>
          <option value="dropout">Dropout</option>
        </select>
      </div>

      <div id="panel-normal"   class="tab-panel active">${normalHtml}</div>
      <div id="panel-archived" class="tab-panel">${archivedHtml}</div>
      <div id="panel-deleted"  class="tab-panel">${deletedHtml}</div>

    </main>
  </div>

  <script>
    let activeTab = 'normal'

    function switchTab(tab) {
      activeTab = tab
      document.querySelectorAll('.admin-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab))
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
      document.getElementById('panel-' + tab).classList.add('active')
      document.getElementById('filter-campus').value = ''
      document.getElementById('filter-year').value = ''
      rebuildCampusDropdown()
      applyFilters()
    }

    function rebuildCampusDropdown() {
      const panel    = document.getElementById('panel-' + activeTab)
      const seen     = new Set()
      panel.querySelectorAll('.admin-row').forEach(r => { if (r.dataset.campus) seen.add(r.dataset.campus) })
      const sel      = document.getElementById('filter-campus')
      const current  = sel.value
      sel.innerHTML  = '<option value="">Filter by Campus</option>'
      ;[...seen].sort().forEach(c => {
        const o = document.createElement('option')
        o.value = c; o.textContent = c
        sel.appendChild(o)
      })
      if ([...seen].includes(current)) sel.value = current
    }

    function applyFilters() {
      const campus = document.getElementById('filter-campus').value
      const year   = document.getElementById('filter-year').value
      const panel  = document.getElementById('panel-' + activeTab)
      panel.querySelectorAll('.admin-row').forEach(row => {
        const cm = !campus || row.dataset.campus === campus
        const ym = !year   || row.dataset.year   === year
        row.style.display = (cm && ym) ? '' : 'none'
      })
    }

    function updateCounts() {
      document.getElementById('count-normal').textContent   = document.querySelectorAll('#panel-normal .admin-row').length
      document.getElementById('count-archived').textContent = document.querySelectorAll('#panel-archived .admin-row').length
      document.getElementById('count-deleted').textContent  = document.querySelectorAll('#panel-deleted .admin-row').length
    }

    function moveCard(id, destPanelId) {
      const card = document.getElementById('row-' + id)
      if (!card) return
      const srcPanel = card.closest('.tab-panel')
      card.style.display = ''
      card.remove()
      if (srcPanel && srcPanel.querySelectorAll('.admin-row').length === 0) {
        const msg = document.createElement('p')
        msg.className = 'empty-state'; msg.style.padding = '16px 0'; msg.textContent = 'No submissions.'
        srcPanel.appendChild(msg)
      }
      const dest = document.getElementById(destPanelId)
      if (!dest) { location.reload(); return }
      const empty = dest.querySelector('.empty-state')
      if (empty) empty.remove()
      dest.prepend(card)
      updateCounts()
      rebuildCampusDropdown()
    }

    function showFlagForm(type, id) {
      document.getElementById('flag-btn-'  + type + '-' + id).style.display = 'none'
      const form = document.getElementById('flag-form-' + type + '-' + id)
      form.style.display = 'inline-flex'
      document.getElementById('flag-inp-' + type + '-' + id).focus()
    }
    function cancelFlag(type, id) {
      document.getElementById('flag-form-' + type + '-' + id).style.display = 'none'
      document.getElementById('flag-btn-'  + type + '-' + id).style.display = 'inline-block'
      document.getElementById('flag-inp-'  + type + '-' + id).value = ''
    }
    async function confirmFlag(type, id) {
      const reason = document.getElementById('flag-inp-' + type + '-' + id).value.trim() || 'Flagged by admin'
      const ep = type === 'fb' ? 'flag-feedback' : 'flag-guidance'
      const r = await api(ep + '/' + id, { reason })
      if (r) location.reload()
    }
    async function doUnflag(type, id) {
      const ep = type === 'fb' ? 'unflag-feedback' : 'unflag-guidance'
      if (await api(ep + '/' + id)) location.reload()
    }

    async function doArchive(id)   { if (await api('archive/'   + id)) moveCard(id, 'panel-archived') }
    async function doUnarchive(id) { if (await api('unarchive/' + id)) moveCard(id, 'panel-normal') }
    async function doDelete(id)    { if (!confirm('Move to Deleted?')) return; if (await api('delete/' + id)) moveCard(id, 'panel-deleted') }
    async function doRestore(id)   { if (await api('restore/'   + id)) moveCard(id, 'panel-normal') }

    async function api(endpoint, body) {
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      if (body) opts.body = JSON.stringify(body)
      const r = await fetch('/api/burkmin/' + endpoint, opts)
      if (!r.ok) { alert('Error: ' + (await r.text())); return false }
      return true
    }

    rebuildCampusDropdown()
  </script>
</body>
</html>`
}

function render404() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Not Found — Rate My Campus Wellbeing</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="page-404">
    <h1>Campus not found.</h1>
    <p>The campus you're looking for doesn't exist in our system yet.</p>
    <a href="/" class="btn-primary">← Back to home</a>
  </div>
</body>
</html>`
}

// ── Utility: escape HTML to prevent XSS ─────────────────────
function escapeHtml(str) {
  if (!str) return ''
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;')
}

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`RMCW running on port ${PORT}`)
})

export default app