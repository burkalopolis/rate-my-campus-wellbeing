// ============================================================
// Rate My Campus Wellbeing — server.js
// Express app · Supabase backend · Mobile-first
// ============================================================

import express from 'express'
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

// ── Express setup ───────────────────────────────────────────
const app = express()
app.set("trust proxy", 1)
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))

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

  if (campusSlug) {
    const { data } = await supabase
      .from('campuses')
      .select('id, slug, name, system, city')
      .eq('slug', campusSlug)
      .single()
    campus = data
  }

  res.send(renderSubmitFlow(campus))
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
      created_at,
      submitters (
        community_tags,
        archetype_self
      )
    `)
    .eq('campus_id', campus.id)
    .eq('approved', true)
    .order('created_at', { ascending: false })
    .limit(20)

  // Total approved submission count
  const { count } = await supabase
    .from('submissions')
    .select('id', { count: 'exact', head: true })
    .eq('campus_id', campus.id)
    .eq('approved', true)

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
  const { campus, dimension, archetype } = req.query
  res.send(renderReceipt(campus, dimension, archetype))
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
      created_at,
      flagged,
      campuses ( name, slug )
    `)
    .eq('approved', false)
    .eq('flagged', false)
    .order('created_at', { ascending: true })
    .limit(50)

  res.send(renderAdminQueue(pending || []))
})

// ============================================================
// API ROUTES
// ============================================================

// ── POST /api/submit ────────────────────────────────────────
app.post('/api/submit', submitLimiter, async (req, res) => {
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
    major
  } = req.body

  // Basic validation
  if (!campus_id || !subject_tag || !dimension_tag || !feedback_text) {
    return res.status(400).json({
      error: 'Missing required fields: campus_id, subject_tag, dimension_tag, feedback_text'
    })
  }

  if (feedback_text.length < 30 || feedback_text.length > 500) {
    return res.status(400).json({
      error: 'Feedback must be between 30 and 500 characters'
    })
  }

  // Basic profanity check placeholder
  // Replace with a proper library in production
  const blocked = ['spam', 'test123']
  const lower = feedback_text.toLowerCase()
  if (blocked.some(w => lower.includes(w))) {
    return res.status(400).json({ error: 'Feedback contains blocked content' })
  }

  try {
    // 1. Create submitter record
    const { data: submitter, error: submitterError } = await supabase
      .from('submitters')
      .insert({
        community_tags: community_tags || [],
        archetype_self: archetype_self || null,
        student_type: 'unknown'
      })
      .select('id')
      .single()

    if (submitterError) throw submitterError

    // 2. Create submission record
    // Note: archetype_derived is set automatically by the database trigger
    const { data: submission, error: submissionError } = await supabase
      .from('submissions')
      .insert({
        campus_id,
        submitter_id: submitter.id,
        subject_tag,
        dimension_tag,
        prompt_mode: prompt_mode || 'free',
        prompt_used: prompt_used || null,
        feedback_text: feedback_text.trim(),
        year_in_school: year_in_school || null,
        major: major || null,
        approved: false
      })
      .select('id, archetype_derived')
      .single()

    if (submissionError) throw submissionError

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
  ).join('')

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
</body>
</html>`
}

function renderSubmitFlow(campus) {
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

    <!-- Step 1: Who are you? -->
    <div class="step" id="step-1">
      <p class="step-eyebrow">About you</p>
      <h2>Which communities are you part of?</h2>
      <p class="step-sub">Select all that apply. Completely optional.</p>

      <div class="bubble-grid" id="community-tags">
        <button class="bubble" data-value="first-gen">First-Gen</button>
        <button class="bubble" data-value="transfer">Transfer</button>
        <button class="bubble" data-value="international">International</button>
        <button class="bubble" data-value="lgbtq">LGBTQ+</button>
        <button class="bubble" data-value="disability">Disability</button>
        <button class="bubble" data-value="greek-life">Greek Life</button>
        <button class="bubble" data-value="athletics">Athletics</button>
        <button class="bubble" data-value="student-gov">Student Gov</button>
        <button class="bubble" data-value="veteran">Veteran</button>
        <button class="bubble" data-value="commuter">Commuter</button>
        <button class="bubble" data-value="graduate">Graduate</button>
        <button class="bubble" data-value="intramurals">Intramurals</button>
        <button class="bubble" data-value="clubs">Clubs</button>
        <button class="bubble" data-value="on-campus-living">On Campus Living</button>
        <button class="bubble" data-value="undocumented">Undocumented/DACA</button>
      </div>

      <h3 class="section-divider">Which archetype feels most like you?</h3>
      <p class="step-sub">Go with your gut. Optional.</p>

      <div class="archetype-grid" id="archetype-select">
        <button class="archetype-card guardian" data-value="guardian">
          <span class="arch-emoji">🏔️</span>
          <span class="arch-name">Architect</span>
          <span class="arch-phase">Prepare</span>
          <span class="arch-desc">You notice things before they become problems.</span>
        </button>
        <button class="archetype-card warrior" data-value="warrior">
          <span class="arch-emoji">⚡</span>
          <span class="arch-name">Warrior</span>
          <span class="arch-phase">Respond</span>
          <span class="arch-desc">Pressure doesn't break you. It activates you.</span>
        </button>
        <button class="archetype-card guide" data-value="guide">
          <span class="arch-emoji">🍃</span>
          <span class="arch-name">Guide</span>
          <span class="arch-phase">Anticipate</span>
          <span class="arch-desc">Where others see the present, you see the pattern.</span>
        </button>
        <button class="archetype-card healer" data-value="healer">
          <span class="arch-emoji">💦</span>
          <span class="arch-name">Healer</span>
          <span class="arch-phase">Recover</span>
          <span class="arch-desc">You know how to bounce back.</span>
        </button>
      </div>

      <a class="discover-link"
         href="https://www.campusmind.org/demo"
         target="_blank">
        Not sure? Discover your archetype at CampusMind →
      </a>

      <button class="btn-primary step-next" data-next="2">
        Continue →
      </button>
    </div>

    <!-- Step 2: What are you rating? -->
    <div class="step hidden" id="step-2">
      <p class="step-eyebrow">Your feedback</p>
      <h2>What are you speaking to?</h2>
      <p class="step-sub">Pick one subject and one dimension.</p>

      <h3 class="field-label">Subject <span class="field-hint">(pick up to 2)</span></h3>
      <div class="bubble-grid single" id="subject-tags">
        <button class="bubble" data-value="campus-overall">Campus Overall</button>
        <button class="bubble" data-value="department-major">Department / Major</button>
        <button class="bubble" data-value="facility">Facility</button>
        <button class="bubble" data-value="program">Program</button>
        <button class="bubble" data-value="resource">Resource</button>
        <button class="bubble" data-value="transition-experience">Transition Experience</button>
      </div>

      <h3 class="field-label">Wellness Dimension <span class="field-hint">(pick up to 2)</span></h3>
      <div class="bubble-grid single" id="dimension-tags">
        <button class="bubble dim-physical"     data-value="physical">Physical / Fitness</button>
        <button class="bubble dim-emotional"    data-value="emotional">Emotional / Mental</button>
        <button class="bubble dim-intellectual" data-value="intellectual">Academic / Intellectual</button>
        <button class="bubble dim-social"       data-value="social">Social Connection</button>
        <button class="bubble dim-spiritual"    data-value="spiritual">Spiritual / Direction</button>
        <button class="bubble dim-environmental" data-value="environmental">Environment / Safety</button>
        <button class="bubble dim-occupational" data-value="occupational">Career / Occupational</button>
        <button class="bubble dim-financial"    data-value="financial">Financial</button>
        <button class="bubble dim-holistic" data-value="holistic">Holistic — All 8 Dimensions</button>
      </div>

      <button class="btn-primary step-next" data-next="3" id="step2-next" disabled>
        Continue →
      </button>
    </div>

    <!-- Step 3: Your feedback -->
    <div class="step hidden" id="step-3">
      <p class="step-eyebrow">Your voice</p>
      <h2>What's the wellbeing experience really like?</h2>

      <div class="prompt-toggle">
        <button class="toggle-btn active" id="toggle-free">Write freely</button>
        <button class="toggle-btn" id="toggle-prompted">Give me a prompt</button>
      </div>

      <div id="prompt-selector" class="hidden">
        <select id="prompt-select" class="prompt-dropdown">
          <option value="">— Choose a sentence starter —</option>
          <option value="The thing that helped me most was...">
            The thing that helped me most was...</option>
          <option value="I wish I had known...">
            I wish I had known...</option>
          <option value="The hardest part was...">
            The hardest part was...</option>
          <option value="What surprised me about support here...">
            What surprised me about support here...</option>
          <option value="If I could change one thing...">
            If I could change one thing...</option>
        </select>
      </div>

      <textarea
        id="feedback-text"
        class="feedback-textarea"
        placeholder="In your own words — what do students need to know?"
        minlength="30"
        maxlength="500"
      ></textarea>
      <div class="char-count">
        <span id="char-current">0</span> / 500
        <span id="char-min-hint"> (30 minimum)</span>
      </div>

      <p class="instinct-tip">💡 Go with your first instinct.
         Honest beats polished every time.</p>

      <div class="optional-fields">
        <p class="field-label">A little more context (optional)</p>
        <div class="year-pills" id="year-select">
          <button class="bubble" data-value="1st">1st year</button>
          <button class="bubble" data-value="2nd">2nd year</button>
          <button class="bubble" data-value="3rd">3rd year</button>
          <button class="bubble" data-value="4th">4th year</button>
          <button class="bubble" data-value="grad">Grad</button>
          <button class="bubble" data-value="alumni">Alumni</button>
          <button class="bubble" data-value="dropout">Dropout</button>
        </div>
        <input
          type="text"
          id="major-input"
          class="major-input"
          placeholder="Major / Department (optional)"
          maxlength="80"
        >
      </div>

      <button class="btn-primary" id="submit-btn" disabled>
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
      archetype_self:  null,
      subject_tag:     null,
      dimension_tag:   null,
      prompt_mode:     'free',
      prompt_used:     null,
      feedback_text:   '',
      year_in_school:  null,
      major:           null
    }

    // ── Step navigation ────────────────────────────────────
    function goToStep(n) {
      document.querySelectorAll('.step').forEach(s => s.classList.add('hidden'))
      document.getElementById('step-' + n).classList.remove('hidden')
      const pct = (n / 4) * 100
      document.getElementById('progress-fill').style.width = pct + '%'
      document.getElementById('progress-label').textContent =
        'Step ' + n + ' of 4'
      window.scrollTo(0, 0)
    }

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

    // ── Single-select archetype ────────────────────────────
    document.getElementById('archetype-select')
      .addEventListener('click', e => {
        const btn = e.target.closest('.archetype-card')
        if (!btn) return
        document.querySelectorAll('.archetype-card')
          .forEach(b => b.classList.remove('selected'))
        btn.classList.add('selected')
        state.archetype_self = btn.dataset.value
      })

    // ── Step 1 → Step 2 ────────────────────────────────────
    document.querySelectorAll('.step-next').forEach(btn => {
      btn.addEventListener('click', () => {
        goToStep(parseInt(btn.dataset.next))
      })
    })

    // ── Single-select subject ──────────────────────────────
    document.getElementById('subject-tags')
      .addEventListener('click', e => {
        const btn = e.target.closest('.bubble')
        if (!btn) return
        document.querySelectorAll('#subject-tags .bubble')
          .forEach(b => b.classList.remove('selected'))
        btn.classList.add('selected')
        state.subject_tag = btn.dataset.value
        checkStep2()
      })

    // ── Single-select dimension ────────────────────────────
    document.getElementById('dimension-tags')
      .addEventListener('click', e => {
        const btn = e.target.closest('.bubble')
        if (!btn) return
        document.querySelectorAll('#dimension-tags .bubble')
          .forEach(b => b.classList.remove('selected'))
        btn.classList.add('selected')
        state.dimension_tag = btn.dataset.value
        checkStep2()
      })

    function checkStep2() {
      document.getElementById('step2-next').disabled =
        !(state.subject_tag && state.dimension_tag)
    }

    // ── Prompt toggle ──────────────────────────────────────
    document.getElementById('toggle-free').addEventListener('click', () => {
      state.prompt_mode = 'free'
      document.getElementById('toggle-free').classList.add('active')
      document.getElementById('toggle-prompted').classList.remove('active')
      document.getElementById('prompt-selector').classList.add('hidden')
      document.getElementById('feedback-text').value = ''
      state.prompt_used = null
    })

    document.getElementById('toggle-prompted').addEventListener('click', () => {
      state.prompt_mode = 'prompted'
      document.getElementById('toggle-prompted').classList.add('active')
      document.getElementById('toggle-free').classList.remove('active')
      document.getElementById('prompt-selector').classList.remove('hidden')
    })

    document.getElementById('prompt-select').addEventListener('change', e => {
      const val = e.target.value
      state.prompt_used = val
      document.getElementById('feedback-text').value = val
      document.getElementById('feedback-text').focus()
    })

    // ── Feedback textarea ──────────────────────────────────
    const textarea = document.getElementById('feedback-text')
    const charCurrent = document.getElementById('char-current')
    const charMinHint = document.getElementById('char-min-hint')
    const submitBtn   = document.getElementById('submit-btn')

    textarea.addEventListener('input', () => {
      const len = textarea.value.length
      charCurrent.textContent = len
      charMinHint.style.display = len >= 30 ? 'none' : 'inline'
      state.feedback_text = textarea.value
      submitBtn.disabled = len < 30
    })

    // ── Year pills ─────────────────────────────────────────
    document.getElementById('year-select')
      .addEventListener('click', e => {
        const btn = e.target.closest('.bubble')
        if (!btn) return
        document.querySelectorAll('#year-select .bubble')
          .forEach(b => b.classList.remove('selected'))
        btn.classList.add('selected')
        state.year_in_school = btn.dataset.value
      })

    // ── Major input ────────────────────────────────────────
    document.getElementById('major-input').addEventListener('input', e => {
      state.major = e.target.value || null
    })

    // ── Submit ─────────────────────────────────────────────
    submitBtn.addEventListener('click', async () => {
      if (state.feedback_text.length < 30) return
      goToStep(4)

      try {
        const res = await fetch('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state)
        })
        const data = await res.json()

        if (data.success) {
          window.location.href = '/receipt' +
            '?campus=' + encodeURIComponent(state.campus_name) +
            '&dimension=' + encodeURIComponent(state.dimension_tag) +
            '&archetype=' + encodeURIComponent(data.archetype_derived || '')
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

function renderReceipt(campusName, dimension, archetype) {
  const archetypeLabels = {
    guardian: { emoji: '🏔️', name: 'The Architect', phase: 'Prepare' },
    warrior:  { emoji: '⚡', name: 'The Warrior',  phase: 'Respond' },
    healer:   { emoji: '💦', name: 'The Healer',   phase: 'Recover' },
    guide:    { emoji: '🍃', name: 'The Guide',    phase: 'Anticipate' }
  }
  const arch = archetypeLabels[archetype] || null

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

    <div class="receipt-confirm">
      <div class="confirm-icon">✓</div>
      <h1>Your voice is in.</h1>
      <p>Your experience just made this campus more legible
         for the next student.</p>
    </div>

    ${arch ? `
    <div class="receipt-archetype">
      <p class="receipt-label">Your feedback was tagged as</p>
      <div class="arch-pill ${archetype}">
        ${arch.emoji} ${arch.name} · ${arch.phase}
      </div>
    </div>` : ''}

    <div class="receipt-divider">
      <span>Now — how are <em>you</em> doing?</span>
    </div>

    <div class="campusmind-bridge">
      <div class="bridge-logo">CampusMind</div>
      <p class="bridge-eyebrow">Resilience Self-Assessment</p>
      <h2>Discover Your Resilience Archetype</h2>
      <div class="trust-row">
        <span class="trust-pill light">8 Questions</span>
        <span class="trust-pill light">~3 Minutes</span>
        <span class="trust-pill light">No Login</span>
      </div>
      <a href="https://www.campusmind.org/demo"
         target="_blank"
         class="btn-primary btn-gold">
        Find Your Profile →
      </a>
      <p class="bridge-sub">Free · No sign-up required · Secure</p>
    </div>

  </div>
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

  const feedItems = submissions.map(s => `
    <div class="feed-entry" data-dim="${s.dimension_tag}">
      <div class="feed-meta">
        ${s.year_in_school ? `<span class="meta-pill">${s.year_in_school} year</span>` : ''}
        ${s.major ? `<span class="meta-pill">${s.major}</span>` : ''}
        <span class="meta-pill">${campus.name}</span>
      </div>
      <p class="feed-text">${escapeHtml(s.feedback_text)}</p>
      <div class="feed-tags">
        <span class="feed-tag dim-tag-${s.dimension_tag}">
          ${dimLabels[s.dimension_tag] || s.dimension_tag}
        </span>
        ${s.archetype_derived ? `
        <span class="feed-tag arch-tag">
          ${archLabels[s.archetype_derived]?.emoji}
          ${archLabels[s.archetype_derived]?.name}
        </span>` : ''}
      </div>
    </div>
  `).join('')

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
          <div class="filter-chips">
            <button class="chip active" data-filter="all">All</button>
            <button class="chip" data-filter="emotional">Emotional</button>
            <button class="chip" data-filter="academic">intellectual</button>
            <button class="chip" data-filter="social">Social</button>
            <button class="chip" data-filter="financial">Financial</button>
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
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip')
          .forEach(c => c.classList.remove('active'))
        chip.classList.add('active')
        const filter = chip.dataset.filter
        document.querySelectorAll('.feed-entry').forEach(entry => {
          entry.style.display =
            filter === 'all' || entry.dataset.dim === filter
              ? '' : 'none'
        })
      })
    })
  </script>
</body>
</html>`
}

function renderAdminQueue(pending) {
  const rows = pending.map(s => `
    <div class="admin-row" id="row-${s.id}">
      <div class="admin-meta">
        <strong>${s.campuses?.name || 'Unknown'}</strong>
        <span class="meta-pill">${s.dimension_tag}</span>
        <span class="meta-pill">${s.archetype_derived || '—'}</span>
        <span class="meta-pill">${s.year_in_school || '—'}</span>
        <span class="meta-pill">${s.major || '—'}</span>
        <span class="meta-date">
          ${new Date(s.created_at).toLocaleDateString()}
        </span>
      </div>
      <p class="admin-text">${escapeHtml(s.feedback_text)}</p>
      <div class="admin-actions">
        <button class="btn-approve" onclick="approve('${s.id}')">
          ✓ Approve
        </button>
        <button class="btn-flag" onclick="flag('${s.id}')">
          ✗ Flag
        </button>
      </div>
    </div>
  `).join('')

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