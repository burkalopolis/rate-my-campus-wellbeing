// ============================================================
// Rate My Campus Wellbeing — server.js
// Express app · Supabase backend · Mobile-first
// ============================================================

import express from 'express'
import rateLimit from 'express-rate-limit'
import { createClient } from '@supabase/supabase-js'
import multer from 'multer'
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

// ── Express setup ───────────────────────────────────────────
const app = express()
app.set("trust proxy", 1)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))

// ── Multer — memory storage, upload to Supabase Storage ────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif"]
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only jpg/png/gif allowed"), false)
  }
})

// ── Rate limiting ───────────────────────────────────────────
// Prevent spam submissions — 10 submissions per IP per hour
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many submissions. Please try again later.' }
})

// ── Simple admin auth middleware ────────────────────────────
function requireAdmin(req, res, next) {
  const password = req.headers['x-admin-password'] || req.query.password
  if (password === process.env.ADMIN_PASSWORD) {
    next()
  } else {
    res.status(401).json({ error: 'Unauthorized' })
  }
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

  // Get approved submissions feed
  const { data: submissions } = await supabase
    .from('submissions')
    .select(`
      id,
      feedback_text,
      dimension_tag,
      archetype_derived,
      subject_tag,
      year_in_school,
      major,
      image_url,
      created_at,
      submitters (
        community_tags,
        archetype_self
      )
    `)
    .eq('campus_id', campus.id)
    .eq('approved', true)
    .eq("deleted", false)
    .order('created_at', { ascending: false })
    .limit(20)

  // Total approved submission count
  const { count } = await supabase
    .from('submissions')
    .select('id', { count: 'exact', head: true })
    .eq('campus_id', campus.id)
    .eq('approved', true)
    .eq("deleted", false)

  res.send(renderCampusPage(
    campus,
    archetypeScores || [],
    dimensionScores || [],
    submissions || [],
    count || 0
  ))
})

// ── Receipt page ────────────────────────────────────────────
app.get('/receipt', async (req, res) => {
  const { campus, campus_id, campus_slug, dimension, archetype } = req.query
  res.send(renderReceipt(campus, campus_id, campus_slug, dimension, archetype))
})

// ── POST /api/subscribe ─────────────────────────────────────
app.post('/api/subscribe', upload.none(), async (req, res) => {
  const { email, campus_id, frequency, wants_summary } = req.body
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' })
  }
  try {
    const cleanEmail = email.trim().toLowerCase()
    const wantsBool  = wants_summary === 'true' || wants_summary === true
    const campusUUID = campus_id && campus_id.match(/^[0-9a-f-]{36}$/) ? campus_id : null
    const { error: insErr } = await supabaseAdmin
      .from('email_subscriptions')
      .insert({ email: cleanEmail, campus_id: campusUUID, frequency: frequency || null, wants_summary: wantsBool })
    if (insErr) throw new Error(insErr.message)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Admin queue ─────────────────────────────────────────────
app.get('/admin', requireAdmin, async (req, res) => {
  const { data: pending } = await supabaseAdmin
    .from('submissions')
    .select(`
      id,
      feedback_text,
      dimension_tag,
      archetype_derived,
      subject_tag,
      year_in_school,
      major,
      image_url,
      created_at,
      flagged,
      campuses ( name, slug )
      submitters ( community_tags, archetype_self )
    `)
    .eq('approved', false)
    .eq('flagged', false)
    .order('created_at', { ascending: true })
    .limit(50)

  const { data: approved } = await supabaseAdmin
    .from("submissions")
    .select(`id, feedback_text, dimension_tag, archetype_derived, subject_tag, year_in_school, major, image_url, created_at, campuses ( name, slug ), submitters ( community_tags )`)
    .eq("approved", true)
    .eq("deleted", false)
    .order("created_at", { ascending: false })
    .limit(50)

  res.send(renderAdminQueue(pending || [], approved || []))
})

// ============================================================
// API ROUTES
// ============================================================

// ── POST /api/submit ────────────────────────────────────────
app.post('/api/submit', submitLimiter, upload.single('image'), async (req, res) => {
  const {
    campus_id,
    community_tags,
    archetype_self,
    subject_tag,
    dimension_tag,
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
    // Schema: campus_id, submitter_id, subject_tag, dimension_tag, archetype_derived (trigger),
    //   prompt_mode, prompt_used, feedback_text, year_in_school, major,
    //   flagged (bool NOT NULL), flag_reason, created_at (auto),
    //   deleted, guidance_dimension, guidance_text, communities (text),
    //   rating_physical/emotional/intellectual/social/spiritual/environmental/occupational/financial
    // Removed: approved, image_url
    const feedbackTrimmed = (feedback_text || '').trim() || null

    // communities arrives as repeated FormData fields — normalise to comma-separated text
    const communitiesText = Array.isArray(community_tags)
      ? community_tags.join(',')
      : (community_tags || null)

    const insertPayload = {
      campus_id,
      submitter_id:  submitter.id,
      subject_tag:   subject_tag   || null,
      dimension_tag: dimension_tag || null,
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
      archetype_derived: submission.archetype_derived
    })

  } catch (err) {
    console.error('Submit error:', err)
    res.status(500).json({ error: 'Failed to save submission' })
  }
})

// ── POST /api/admin/approve/:id ─────────────────────────────
app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
  const { id } = req.params

  const { data: submission, error } = await supabaseAdmin
    .from('submissions')
    .update({ approved: true, approved_at: new Date().toISOString() })
    .eq('id', id)
    .select('campus_id')
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // Refresh campus scores after approval
  await supabaseAdmin.rpc('fn_refresh_campus_scores',
    { p_campus_id: submission.campus_id })
  await supabaseAdmin.rpc('fn_refresh_archetype_scores',
    { p_campus_id: submission.campus_id })

  res.json({ success: true })
})

// ── POST /api/admin/flag/:id ────────────────────────────────
app.post('/api/admin/flag/:id', requireAdmin, async (req, res) => {
  const { id } = req.params
  const { reason } = req.body

  const { error } = await supabaseAdmin
    .from('submissions')
    .update({ flagged: true, flag_reason: reason || 'No reason given' })
    .eq('id', id)

  if (error) return res.status(500).json({ error: error.message })

// ── POST /api/admin/delete/:id ─────────────────────────────
app.post("/api/admin/delete/:id", requireAdmin, async (req, res) => {
  const { id } = req.params
  const { error } = await supabaseAdmin
    .from("submissions")
    .update({ deleted: true })
    .eq("id", id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

  res.json({ success: true })
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

      <button class="btn-primary" id="step2-next" disabled>
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
        checkStep2()
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
        checkStep2()
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

    function checkStep2() {
      // Enable Continue when all 8 touched (any value including 0 = N/A)
      const allTouched = RATING_DIMS.every(d => state.ratings[d] !== null)
      document.getElementById('step2-next').disabled = !allTouched
    }

    document.getElementById('step2-next').addEventListener('click', () => {
      const firstUntouched = RATING_DIMS.find(d => state.ratings[d] === null)
      if (firstUntouched) {
        const card = document.getElementById('card-' + firstUntouched)
        card.classList.add('rating-card-error')
        card.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
      // Derive dimension_tag from highest non-N/A rating (drives archetype trigger)
      const nonNA = RATING_DIMS.filter(d => state.ratings[d] > 0)
      state.dimension_tag = nonNA.length
        ? nonNA.reduce((a, b) => state.ratings[a] >= state.ratings[b] ? a : b)
        : RATING_DIMS[0]
      goToStep(3)
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
        const fd = new FormData()
        fd.append("campus_id", state.campus_id)
        fd.append("subject_tag", (state.subject_tags || []).join(','))
        fd.append("dimension_tag", state.dimension_tag || "")
        ;['physical','emotional','intellectual','social','spiritual','environmental','occupational','financial'].forEach(d => {
          if (state.ratings[d] !== null) fd.append('rating_' + d, state.ratings[d])
        })
        fd.append("feedback_text", state.feedback_text)
        if (state.wish_text.trim()) fd.append("wish_text", state.wish_text.trim())
        if (state.wish_dimension) fd.append("wish_dimension", state.wish_dimension)
        if (state.year_in_school) fd.append("year_in_school", state.year_in_school)
        if (state.major) fd.append("major", state.major)
        ;(state.community_tags || []).forEach(t => fd.append("community_tags", t))
        const res = await fetch("/api/submit", { method: "POST", body: fd })
        const data = await res.json()

        if (data.success) {
          window.location.href = '/receipt' +
            '?campus='      + encodeURIComponent(state.campus_name) +
            '&campus_id='   + encodeURIComponent(state.campus_id) +
            '&campus_slug=' + encodeURIComponent(state.campus_slug) +
            '&dimension='   + encodeURIComponent(state.dimension_tag) +
            '&archetype='   + encodeURIComponent(data.archetype_derived || '')
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

function renderReceipt(campusName, campusId, campusSlug, dimension, archetype) {
  const campusHref = campusSlug ? `/campus/${campusSlug}` : '/'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thank You — Rate My Campus Wellbeing</title>
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
        View My Campus Wellbeing
      </a>
    </div>

    <!-- 4. Retake link -->
    <div class="receipt-retake">
      <a href="/submit" class="retake-link">Retake Assessment</a>
    </div>

    <!-- 5. Footer -->
    <footer class="receipt-footer">
      <p>© 2026 Rate My Campus Wellbeing · Resilience Assessment</p>
    </footer>

  </div>

  <script>
    const _campusId = ${JSON.stringify(campusId || null)}
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
        const fd = new FormData()
        fd.append('email', email)
        if (_campusId) fd.append('campus_id', _campusId)
        if (_freq)     fd.append('frequency',  _freq)
        fd.append('wants_summary', wants)
        const r = await fetch('/api/subscribe', { method: 'POST', body: fd })
        const d = await r.json()
        if (d.success) {
          btn.textContent = 'Subscribed ✓'
          status.textContent = "You're on the list."
          status.className = 'subscribe-status success'
        } else {
          btn.disabled = false
          btn.textContent = 'Subscribe'
          status.textContent = 'Something went wrong. Try again.'
          status.className = 'subscribe-status error'
        }
      } catch {
        btn.disabled = false
        btn.textContent = 'Subscribe'
        status.textContent = 'Network error. Try again.'
        status.className = 'subscribe-status error'
      }
    })
  </script>
</body>
</html>`
}

function renderCampusPage(campus, archetypeScores, dimensionScores, submissions, count) {
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
    return [
      '<div class="feed-entry" data-dim="' + (s.dimension_tag||'') + '" data-community="' + communityTags.join(',') + '">',
      '<div class="feed-meta">',
      s.year_in_school ? '<span class="meta-pill">' + s.year_in_school + ' year</span>' : '',
      s.major ? '<span class="meta-pill">' + escapeHtml(s.major) + '</span>' : '',
      communityTags.length ? '<span class="meta-pill">' + communityTags.join(', ') + '</span>' : '',
      '</div>',
      s.image_url ? '<img src="' + escapeHtml(s.image_url) + '" class="feed-image-thumb" alt="Student photo" loading="lazy">' : '',
      '<p class="feed-text">' + escapeHtml(s.feedback_text) + '</p>',
      '<div class="feed-tags">',
      subjectLabel ? '<span class="feed-tag subject-tag">' + escapeHtml(subjectLabel) + '</span>' : '',
      s.dimension_tag ? '<span class="feed-tag dim-tag-' + s.dimension_tag + '">' + (dimLabels[s.dimension_tag] || s.dimension_tag) + '</span>' : '',
      s.archetype_derived && archLabels[s.archetype_derived] ? '<span class="feed-tag arch-tag">' + archLabels[s.archetype_derived].emoji + ' ' + archLabels[s.archetype_derived].name + '</span>' : '',
      '</div></div>'
    ].join('')
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${campus.name} Wellbeing — Rate My Campus Wellbeing</title>
  <meta name="description" content="Student wellbeing scores and reviews for
    ${campus.name}. See how students rate mental health, social connection,
    academic pressure, and more.">
  <link rel="stylesheet" href="/style.css">
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
      <div class="campus-header">
        <div>
          <h1>${campus.name}</h1>
          <p class="campus-meta">
            ${campus.system} System · ${campus.city || ''}
          </p>
        </div>
        <div class="campus-stats">
          <span class="stat-pill">${count} reviews</span>
          ${dominant
            ? `<span class="stat-pill">Leans ${archLabels[dominant.archetype_tag]?.name}</span>`
            : ''}
        </div>
      </div>

      ${count === 0 ? `
      <div class="empty-state">
        <p>No reviews yet for ${campus.name}.</p>
        <a href="/submit?campus=${campus.slug}" class="btn-primary">
          Be the first to share →
        </a>
      </div>` : `

      <div class="scores-grid">
        <div class="scores-panel">
          <p class="panel-label">8 dimensions of wellness</p>
          ${dimensionBars}
        </div>
        <div class="scores-panel">
          <p class="panel-label">Resilience archetype profile</p>
          <div class="arch-grid">
            ${archetypeCards}
          </div>
          ${dominant ? `
          <p class="arch-insight">
            ${campus.name} leans
            <strong>${archLabels[dominant.archetype_tag]?.name}</strong>
            based on ${count} student reviews.
          </p>` : ''}
        </div>
      </div>

      <div class="feed-section">
        <div class="feed-header">
          <p class="panel-label">Student voices</p>
          <div class="community-filter-wrap">
            <button class="chip active" id="filter-all">All</button>
            <button class="chip" id="filter-clear">Clear</button>
            <select id="community-filter-select">
              <option value="">+ Filter by community</option>
              ${[...new Set(submissions.flatMap(s => s.submitters?.community_tags || []))].sort().map(t =>
                `<option value="${t}">${t}</option>`
              ).join('')}
            </select>
            <div class="active-filter-chips" id="active-chips"></div>
          </div>
        </div>
        <div id="feed">
          ${feedItems || '<p class="empty-feed">No approved reviews yet.</p>'}
        </div>
      </div>
      `}

      <div class="campus-cta">
        <p>Add your voice to the conversation.</p>
        <a href="/submit?campus=${campus.slug}" class="btn-primary">
          Rate This Campus →
        </a>
      </div>
    </main>
  </div>

  <script>
    const activeFilters = new Set()

    function applyFilters() {
      const entries = document.querySelectorAll('.feed-entry')
      entries.forEach(entry => {
        if (activeFilters.size === 0) { entry.style.display = ''; return }
        const community = (entry.dataset.community || '').split(',').map(t => t.trim())
        entry.style.display = [...activeFilters].some(f => community.includes(f)) ? '' : 'none'
      })
      document.getElementById('filter-all').classList.toggle('active', activeFilters.size === 0)
    }

    function addChip(tag) {
      if (activeFilters.has(tag)) return
      activeFilters.add(tag)
      const chip = document.createElement('button')
      chip.className = 'chip active-chip'
      chip.innerHTML = tag + ' <span class="chip-remove">✕</span>'
      chip.addEventListener('click', () => {
        activeFilters.delete(tag)
        chip.remove()
        applyFilters()
        document.getElementById('community-filter-select').value = ''
      })
      document.getElementById('active-chips').appendChild(chip)
      applyFilters()
    }

    const filterAll = document.getElementById('filter-all')
    if (filterAll) {
      filterAll.addEventListener('click', () => {
        activeFilters.clear()
        document.getElementById('active-chips').innerHTML = ''
        document.getElementById('community-filter-select').value = ''
        applyFilters()
      })
    }

    const filterClear = document.getElementById('filter-clear')
    if (filterClear) {
      filterClear.addEventListener('click', () => {
        activeFilters.clear()
        document.getElementById('active-chips').innerHTML = ''
        document.getElementById('community-filter-select').value = ''
        applyFilters()
      })
    }

    const communityFilter = document.getElementById('community-filter-select')
    if (communityFilter) {
      communityFilter.addEventListener('change', e => {
        if (e.target.value) { addChip(e.target.value); e.target.value = '' }
      })
    }
  </script>
</body>
</html>`
}

function renderAdminQueue(pending, approved) {
  const rows = pending.map(s => {
    const communityTags = s.submitters?.community_tags || []
    return [
      '<div class="admin-row" id="row-' + s.id + '">',
      '<div class="admin-meta">',
      '<strong>' + escapeHtml(s.campuses?.name || 'Unknown') + '</strong>',
      s.subject_tag ? '<span class="meta-pill">' + escapeHtml(s.subject_tag) + '</span>' : '',
      s.dimension_tag ? '<span class="meta-pill">' + escapeHtml(s.dimension_tag) + '</span>' : '',
      s.archetype_derived ? '<span class="meta-pill">' + escapeHtml(s.archetype_derived) + '</span>' : '',
      s.year_in_school ? '<span class="meta-pill">' + escapeHtml(s.year_in_school) + ' year</span>' : '',
      s.major ? '<span class="meta-pill">' + escapeHtml(s.major) + '</span>' : '',
      communityTags.length ? '<span class="meta-pill">' + communityTags.join(', ') + '</span>' : '',
      '<span class="meta-date">' + new Date(s.created_at).toLocaleDateString('en-US', {timeZone: 'America/Los_Angeles'}) + '</span>',
      '</div>',
      s.image_url ? '<img src="' + escapeHtml(s.image_url) + '" class="admin-image-thumb" alt="Submission image">' : '',
      '<p class="admin-text">' + escapeHtml(s.feedback_text) + '</p>',
      '<div class="admin-actions">',
      '<button class="btn-approve" onclick="approve(\u0027' + s.id + '\u0027)">✓ Approve</button>',
      '<button class="btn-flag" onclick="flag(\u0027' + s.id + '\u0027)">✗ Flag</button>',
      '</div></div>'
    ].join('')
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Rate My Campus Wellbeing</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="page-admin">
    <header class="nav">
      <span class="nav-logo">RMCW Admin</span>
      <span class="admin-count">${pending.length} pending</span>
    </header>
    <main class="admin-main">
      ${pending.length === 0
        ? '<p class="empty-state">Queue is clear. Nothing to review.</p>'
        : rows
      }
      <div class="admin-section">
        <h3 class="admin-section-title">Approved (${approved.length})</h3>
        ${approved.length === 0 ? '<p class="empty-state">No approved submissions yet.</p>' : approved.map(s => {
          const ct = s.submitters?.community_tags || []
          return [
            '<div class="admin-row approved-row" id="row-' + s.id + '">',
            '<div class="admin-meta">',
            '<strong>' + escapeHtml(s.campuses?.name || '') + '</strong>',
            s.dimension_tag ? '<span class="meta-pill">' + s.dimension_tag + '</span>' : '',
            s.year_in_school ? '<span class="meta-pill">' + s.year_in_school + ' year</span>' : '',
            s.major ? '<span class="meta-pill">' + escapeHtml(s.major) + '</span>' : '',
            ct.length ? '<span class="meta-pill">' + ct.join(', ') + '</span>' : '',
            '<span class="meta-date">' + new Date(s.created_at).toLocaleDateString('en-US', {timeZone: 'America/Los_Angeles'}) + '</span>',
            '</div>',
            s.image_url ? '<img src="' + escapeHtml(s.image_url) + '" class="admin-image-thumb" alt="">' : '',
            '<p class="admin-text">' + escapeHtml(s.feedback_text) + '</p>',
            '<div class="admin-actions">',
            '<button class="btn-delete" onclick="softDelete(\u0027' + s.id + '\u0027)">🗑 Delete</button>',
            '</div></div>'
          ].join('')
        }).join('')}
      </div>
    </main>
  </div>

  <script>
    const pwd = prompt('Admin password:')

    async function approve(id) {
      const res = await fetch('/api/admin/approve/' + id, {
        method: 'POST',
        headers: { 'x-admin-password': pwd }
      })
      if (res.ok) {
        document.getElementById('row-' + id).remove()
      } else {
        alert('Error approving submission')
      }
    }

    async function flag(id) {
      const reason = prompt('Flag reason (optional):') || 'Flagged by admin'
      const res = await fetch('/api/admin/flag/' + id, {
        method: 'POST',
        headers: {
          'x-admin-password': pwd,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason })
      })
      if (res.ok) {
        document.getElementById('row-' + id).remove()
      } else {
        alert('Error flagging submission')
      }
    async function softDelete(id) {
      const confirm = prompt('Type DELETE to permanently remove this submission from the campus page:')
      if (confirm !== 'DELETE') return
      const res = await fetch('/api/admin/delete/' + id, {
        method: 'POST',
        headers: { 'x-admin-password': pwd }
      })
      if (res.ok) {
        document.getElementById('row-' + id).remove()
      } else {
        alert('Error deleting submission')
      }
    }
    }
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