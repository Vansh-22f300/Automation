<script setup lang="ts">
definePageMeta({ layout: 'landing' });

const isMenuOpen = ref(false);
const isScrolled = ref(false);
const progress = ref(0);

function toggleMenu() { isMenuOpen.value = !isMenuOpen.value; }
function closeMenu() { isMenuOpen.value = false; }

onMounted(() => {
  const onScroll = () => {
    isScrolled.value = window.scrollY > 8;
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    progress.value = max > 0 ? window.scrollY / max : 0;
    document.documentElement.style.setProperty('--progress', String(progress.value));
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) e.target.classList.add('is-visible');
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

  onUnmounted(() => {
    window.removeEventListener('scroll', onScroll);
    observer.disconnect();
  });
});

const year = new Date().getFullYear();
</script>

<template>
  <div>
    <!-- progress -->
    <div class="landing-progress" aria-hidden="true" />

    <!-- Sticky nav — dark glass -->
    <header class="landing-nav" :class="{ 'is-scrolled': isScrolled }">
      <div class="landing-nav-row">
        <NuxtLink to="/" class="landing-brand" aria-label="AI Workforce home">
          <span class="landing-brand-mark" aria-hidden="true"><span style="font-size:14px;font-weight:650">◈</span></span>
          <strong>AI Workforce</strong>
        </NuxtLink>

        <nav class="landing-links" :class="{ 'is-open': isMenuOpen }" aria-label="Primary">
          <a href="#product" @click="closeMenu">Product</a>
          <a href="#capabilities" @click="closeMenu">Capabilities</a>
          <a href="#how-it-works" @click="closeMenu">How it works</a>
          <a href="#faq" @click="closeMenu">FAQ</a>
        </nav>

        <div class="landing-ctas">
          <NuxtLink to="/workflows" class="button button-primary btn-shine" style="height:36px;border-radius:999px;background:var(--landing-mist);color:var(--landing-void);border-color:transparent">Open Workspace <span aria-hidden="true" style="margin-left:2px">↗</span><span class="shine-strip" aria-hidden="true" /></NuxtLink>
          <button class="landing-hamburger" type="button" :aria-expanded="isMenuOpen ? 'true' : 'false'" aria-label="Toggle menu" @click="toggleMenu">
            <span aria-hidden="true">{{ isMenuOpen ? '✕' : '☰' }}</span>
          </button>
        </div>
      </div>
    </header>

    <!-- Hero — cinematic -->
    <section id="main" tabindex="-1" class="hero">
      <div aria-hidden="true" class="bg-grid-dark" style="position:absolute;inset:0;opacity:1;mask-image:linear-gradient(to bottom, transparent, black 18%, black 78%, transparent);-webkit-mask-image:linear-gradient(to bottom, transparent, black 18%, black 78%, transparent)" />
      <!-- aurora blobs — clipped to the hero by .hero-aura (no hero overflow:hidden needed) -->
      <div aria-hidden="true" class="hero-aura">
        <div aria-hidden="true" class="ambient-blob" style="left:12%;top:-12%;width:720px;height:620px;background:rgba(183,164,251,0.14);filter:blur(140px);animation:drift-a 26s ease-in-out infinite alternate" />
        <div aria-hidden="true" class="ambient-blob" style="right:-6%;top:6%;width:640px;height:540px;background:rgba(139,245,201,0.11);filter:blur(130px);animation:drift-b 34s ease-in-out infinite alternate" />
        <div aria-hidden="true" class="ambient-blob" style="left:28%;bottom:-18%;width:680px;height:520px;background:rgba(245,168,224,0.10);filter:blur(140px);animation:drift-c 22s ease-in-out infinite alternate" />
      </div>

      <div class="landing-inner" style="position:relative;z-index:2">
        <div class="hero-grid">
          <div class="hero-copy reveal">
            <div style="display:inline-flex;align-items:center;gap:10px;padding:6px 14px 6px 8px;border-radius:999px;border:1px solid var(--landing-border);background:rgba(255,255,255,0.04);backdrop-filter:blur(8px);font-size:12px;color:var(--landing-dim)">
              <span style="display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;background:rgba(139,245,201,0.12);border:1px solid rgba(139,245,201,0.22);color:var(--landing-mint);font-weight:600;font-size:11px;letter-spacing:0.06em;text-transform:uppercase"><span style="width:6px;height:6px;border-radius:999px;background:var(--landing-mint);box-shadow:0 0 0 4px rgba(139,245,201,0.18)" aria-hidden="true" /> Live workspace</span>
              Workflows · Runs · Connections · Inspectable
            </div>
            <h1>Turn repetitive operations <em>into autonomous workflows.</em></h1>
            <p class="hero-lead">
              AI Workforce is a workflow automation platform for teams who ship. Define once, trigger via webhook, execute with AI where it helps — and inspect every run.
            </p>
            <div class="hero-actions">
              <NuxtLink to="/workflows" class="button button-primary btn-shine" style="height:42px;border-radius:999px;padding:0 22px;background:var(--landing-mist);color:var(--landing-void);border:0;font-weight:600">Open Workspace <span aria-hidden="true">→</span><span class="shine-strip" aria-hidden="true" /></NuxtLink>
              <a href="#capabilities" class="button button-secondary" style="height:42px;border-radius:999px;background:rgba(255,255,255,0.06);border-color:var(--landing-border);color:var(--landing-mist);backdrop-filter:blur(8px)">Explore capabilities</a>
            </div>
            <p class="hero-note"><strong>Built for real operations.</strong> Webhooks · AI steps · encrypted connections · visible execution.</p>
          </div>

          <div class="hero-visual reveal product-hero-wrap" style="--delay:80ms">
            <div class="product-hero-glow" aria-hidden="true" />
            <div class="product-stack">
              <!-- workflow surface -->
              <div class="product-surface" style="padding:16px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
                  <div style="display:flex;align-items:center;gap:10px">
                    <span class="landing-brand-mark" style="width:28px;height:28px;background:var(--landing-mist);color:var(--landing-void);border-radius:9px">◈</span>
                    <div>
                      <strong style="display:block;font-size:12px;letter-spacing:-0.01em;color:var(--landing-mist)">invoice-triage · v3</strong>
                      <span style="font-size:11px;color:var(--landing-faint)">workflow · webhook · stripe</span>
                    </div>
                  </div>
                  <span class="status-badge status-success" style="height:22px;font-size:11px;background:rgba(139,245,201,0.12);color:var(--landing-mint);border:1px solid rgba(139,245,201,0.22)">active</span>
                </div>
                <div style="display:grid;gap:8px">
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border);font-size:13px">
                    <span style="display:flex;align-items:center;gap:8px;color:var(--landing-dim)"><span style="width:7px;height:7px;border-radius:999px;background:var(--landing-mint)" aria-hidden="true" />Trigger</span><span class="pill" style="height:22px;background:rgba(255,255,255,0.06);border-color:var(--landing-border);color:var(--landing-mist);font-size:11px">webhook · stripe</span>
                  </div>
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border);font-size:13px">
                    <span style="color:var(--landing-dim)">Steps</span><span style="color:var(--landing-mist);font-size:12px">classify → extract → notify</span>
                  </div>
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border);font-size:13px">
                    <span style="color:var(--landing-dim)">Last run</span><span style="color:var(--landing-mint);font-weight:600;font-size:12px">succeeded · 1.4s</span>
                  </div>
                </div>
              </div>

              <!-- run execution surface — layered -->
              <div class="product-surface gradient-border" style="--gb-fill: #101019;padding:16px;transform: rotate(0.0deg)">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                  <strong style="font-size:12px;color:var(--landing-mist)">Run · 01993a8b-7b2a…</strong>
                  <span class="status-badge status-info" style="height:20px;font-size:11px;background:rgba(183,164,251,0.12);color:var(--landing-lilac);border:1px solid rgba(183,164,251,0.22)">running · step 2/3</span>
                </div>
                <div style="display:grid;gap:10px">
                  <div style="display:flex;gap:10px;align-items:center">
                    <span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:rgba(139,245,201,0.14);color:var(--landing-mint);border:1px solid rgba(139,245,201,0.22);font-size:11px" aria-hidden="true">✓</span>
                    <div style="flex:1">
                      <div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:12px;color:var(--landing-mist)">trigger · stripe</strong><span style="font-family:var(--font-mono);font-size:11px;color:var(--landing-faint)">41ms</span></div>
                      <p style="margin:2px 0 0;color:var(--landing-faint);font-size:11px">webhook · payload summary preview</p>
                    </div>
                  </div>
                  <div style="height:1px;background:var(--landing-border);margin-left:14px" aria-hidden="true" />
                  <div style="display:flex;gap:10px;align-items:center">
                    <span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:rgba(183,164,251,0.14);color:var(--landing-lilac);border:1px solid rgba(183,164,251,0.22);font-size:11px;animation:pulse-dot 2.2s ease-in-out infinite" aria-hidden="true">◷</span>
                    <div style="flex:1">
                      <div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:12px;color:var(--landing-mist)">llm · classify</strong><span style="font-size:11px;color:var(--landing-faint)">128 tok · 420ms</span></div>
                      <p style="margin:2px 0 0;color:var(--landing-faint);font-size:11px">provider · anthropic · attempt 1</p>
                    </div>
                  </div>
                  <div style="height:1px;background:var(--landing-border);margin-left:14px" aria-hidden="true" />
                  <div style="display:flex;gap:10px;align-items:center;opacity:0.7">
                    <span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:rgba(255,255,255,0.06);color:var(--landing-faint);font-size:11px" aria-hidden="true">•</span>
                    <div style="flex:1">
                      <div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:12px;color:var(--landing-faint)">tool · send_slack_message</strong><span style="font-size:11px;color:var(--landing-faint)">queued</span></div>
                      <p style="margin:2px 0 0;color:var(--landing-faint);font-size:11px">lease pending · SKIP LOCKED</p>
                    </div>
                  </div>
                </div>
              </div>

              <div style="display:flex;gap:8px;align-items:center;padding:10px 12px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border);color:var(--landing-faint);font-size:11px;letter-spacing:0.06em;text-transform:uppercase;font-weight:600">
                <span style="width:6px;height:6px;border-radius:999px;background:var(--landing-mint)" aria-hidden="true" /> Workflows
                <span style="opacity:0.4" aria-hidden="true">·</span> AI execution <span style="opacity:0.4">·</span> Webhooks <span style="opacity:0.4">·</span> Run visibility
              </div>
            </div>
            <!-- floating meta -->
            <div class="floating-meta mint" style="right:-10px;top:22%;animation-delay:0.6s" aria-hidden="true">● 15m lease · reaper</div>
            <div class="floating-meta lilac" style="left:-12px;bottom:18%;animation:float-b 9.5s ease-in-out infinite;animation-delay:1.1s" aria-hidden="true">◈ Encrypted at rest</div>
          </div>
        </div>
      </div>
    </section>

    <!-- Problem -> solution — editorial -->
    <section id="product" class="landing-section" style="position:relative">
      <div aria-hidden="true" class="ambient-blob" style="right:4%;top:10%;width:520px;height:520px;background:rgba(183,164,251,0.06);filter:blur(80px)" />
      <div class="landing-inner" style="position:relative">
        <div class="reveal">
          <p class="eyebrow-landing">Why AI Workforce</p>
          <h2 class="section-title" style="max-width:18ch">Repetitive work hides inside every handoff.</h2>
          <p class="section-lead">Scattered tools, manual checks, and unclear execution state turn simple work into toil. AI Workforce turns that work into a deterministic workflow — triggered, executed, and inspectable.</p>
        </div>
        <div class="bento-grid">
          <article class="bento-card card-sheen reveal" style="grid-column:span 4">
            <div style="width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:rgba(255,255,255,0.06);border:1px solid var(--landing-border);color:var(--landing-mist)">◐</div>
            <h3>Before: manual coordination</h3>
            <p>Copying fields, chasing approvals, and re-running the same AI prompts with no audit trail.</p>
            <div class="bento-visual" style="display:flex;gap:8px;flex-wrap:wrap">
              <span class="pill" style="background:rgba(255,255,255,0.04);border-color:var(--landing-border);color:var(--landing-faint)">copy → paste</span>
              <span class="pill" style="background:rgba(255,255,255,0.04);border-color:var(--landing-border);color:var(--landing-faint)">no audit</span>
              <span class="pill" style="background:rgba(255,255,255,0.04);border-color:var(--landing-border);color:var(--landing-faint)">lost context</span>
            </div>
          </article>
          <article class="bento-card card-sheen reveal" style="--delay:60ms;grid-column:span 2;background:linear-gradient(160deg, rgba(139,245,201,0.08), rgba(255,255,255,0.03))">
            <div style="width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:rgba(139,245,201,0.12);border:1px solid rgba(139,245,201,0.22);color:var(--landing-mint)">◎</div>
            <h3>After: defined workflow</h3>
            <p>One workflow, versioned. Triggered by webhook, steps run in order on durable jobs.</p>
            <div class="bento-visual" style="font-family:var(--font-mono);font-size:11px;color:var(--landing-faint)">webhook → classify → notify</div>
          </article>
          <article class="bento-card card-sheen reveal" style="grid-column:span 2">
            <div style="width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:rgba(255,255,255,0.06);border:1px solid var(--landing-border);color:var(--landing-mist)">⬔</div>
            <h3>After: visible result</h3>
            <p>Every run, step, job, and LLM use is recorded — not guessed. Inspect what actually happened.</p>
            <div class="bento-visual" style="display:flex;align-items:center;gap:6px;color:var(--landing-mint);font-size:11px;font-weight:600"><span style="width:6px;height:6px;border-radius:999px;background:var(--landing-mint)" aria-hidden="true" /> timeline · jobs · usage</div>
          </article>
        </div>
      </div>
    </section>

    <!-- Bento capabilities -->
    <section id="capabilities" class="landing-section">
      <div class="landing-inner">
        <p class="eyebrow-landing">Core capabilities</p>
        <h2 class="section-title">AI where it helps. Automation where it matters.</h2>
        <p class="section-lead">Everything below maps to real backend primitives — no inflated claims.</p>

        <div class="bento-grid">
          <article class="bento-card card-sheen reveal bento-card--large" style="--gb-fill: #0a0a11">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="display:grid;place-items:center;width:36px;height:36px;border-radius:12px;background:linear-gradient(135deg, rgba(139,245,201,0.18), rgba(183,164,251,0.18));border:1px solid var(--landing-border);color:var(--landing-mist)">⟁</span>
              <span style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--landing-faint);font-weight:600">Workflow automation</span>
            </div>
            <h3 style="font-size:18px">Versioned definitions that stay pinned.</h3>
            <p>Linear steps with unique keys. Active version pinning so in-flight runs never shift when you ship v4.</p>
            <div class="bento-visual">
              <div style="display:flex;gap:8px;align-items:center">
                <span class="pill" style="background:rgba(255,255,255,0.06);border-color:var(--landing-border);color:var(--landing-mist)">v3 active</span>
                <span style="height:1px;flex:1;background:linear-gradient(90deg, rgba(139,245,201,0.4), rgba(183,164,251,0.4))" aria-hidden="true" />
                <span class="pill" style="background:rgba(255,255,255,0.06);border-color:var(--landing-border);color:var(--landing-faint)">v4 draft</span>
              </div>
              <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px">
                <div style="padding:10px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border)"><strong style="color:var(--landing-mist)">SKIP LOCKED</strong><br><span style="color:var(--landing-faint)">one job at a time</span></div>
                <div style="padding:10px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border)"><strong style="color:var(--landing-mist)">15m leases</strong><br><span style="color:var(--landing-faint)">derived from timeouts</span></div>
              </div>
            </div>
          </article>

          <article class="bento-card card-sheen reveal" style="--delay:60ms">
            <div style="width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:rgba(183,164,251,0.12);border:1px solid rgba(183,164,251,0.22);color:var(--landing-lilac)">✦</div>
            <h3>AI-powered execution</h3>
            <p>LLM steps where reasoning helps — provider-abstracted, with token/latency capture and context summaries.</p>
            <div class="bento-visual" style="display:flex;gap:6px;flex-wrap:wrap">
              <span style="padding:6px 10px;border-radius:999px;background:rgba(183,164,251,0.12);border:1px solid rgba(183,164,251,0.22);color:var(--landing-lilac);font-size:11px">Anthropic</span>
              <span style="padding:6px 10px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border);color:var(--landing-faint);font-size:11px">128 tok · 420ms</span>
            </div>
          </article>

          <article class="bento-card card-sheen reveal" style="--delay:100ms">
            <div style="width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:rgba(255,255,255,0.06);border:1px solid var(--landing-border);color:var(--landing-mist)">↗</div>
            <h3>Webhook triggers</h3>
            <p>POST /v1/webhooks/:source with HMAC-ready rawBody. Dedupe via X-Event-ID or SHA-256.</p>
            <div class="bento-visual" style="font-family:var(--font-mono);font-size:11px;color:var(--landing-faint);padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border)">POST /v1/webhooks/stripe<br><span style="color:var(--landing-dim)">X-Event-ID: evt_…</span></div>
          </article>

          <article class="bento-card card-sheen reveal">
            <div style="width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:rgba(139,245,201,0.12);border:1px solid rgba(139,245,201,0.22);color:var(--landing-mint)">◇</div>
            <h3>Connected tools</h3>
            <p>Provider credentials encrypted at rest (AES-256-GCM), never rendered. Used via connections.</p>
            <div class="bento-visual" style="display:flex;gap:8px;align-items:center">
              <span style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border);font-size:11px;color:var(--landing-mist)"><span style="width:6px;height:6px;border-radius:999px;background:var(--landing-mint)" aria-hidden="true" /> Slack</span>
              <span style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border);font-size:11px;color:var(--landing-mist)"><span style="width:6px;height:6px;border-radius:999px;background:var(--landing-mint)" aria-hidden="true" /> Anthropic</span>
            </div>
          </article>

          <article class="bento-card card-sheen reveal" style="--delay:60ms">
            <div style="width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:rgba(255,255,255,0.06);border:1px solid var(--landing-border);color:var(--landing-mist)">▦</div>
            <h3>Durable execution</h3>
            <p>PostgreSQL-backed jobs, SKIP LOCKED claim, 15-min leases, reaper for expired leases.</p>
            <div class="bento-visual" style="height:1px;background:linear-gradient(90deg, rgba(139,245,201,0.5), rgba(183,164,251,0.5))" aria-hidden="true" />
          </article>

          <article class="bento-card card-sheen reveal" style="--delay:100ms">
            <div style="width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:rgba(245,168,224,0.12);border:1px solid rgba(245,168,224,0.22);color:var(--landing-bloom)">◈</div>
            <h3>Run inspection</h3>
            <p>Steps, jobs, tool rounds, errors and usage — summarized and redacted, not dumped.</p>
            <div class="bento-visual" style="font-size:11px;color:var(--landing-faint)">inputSummary · outputSummary · redacted</div>
          </article>
        </div>
      </div>
    </section>

    <!-- Product showcase — From trigger to outcome -->
    <section class="landing-section">
      <div class="landing-inner">
        <p class="eyebrow-landing">Product showcase</p>
        <h2 class="section-title">The actual application — not a decorative mock.</h2>
        <p class="section-lead">Compositions below are built from real routes: <code>/workflows</code>, <code>/runs</code>, <code>/runs/:runId</code>, <code>/connections</code>.</p>

        <div class="bento-grid">
          <!-- large: run detail -->
          <div class="bento-card reveal bento-card--large product-surface" style="padding:20px;grid-column:span 4">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
              <div style="display:flex;align-items:center;gap:10px">
                <span style="width:10px;height:10px;border-radius:999px;background:var(--landing-mint);box-shadow:0 0 0 6px rgba(139,245,201,0.12)" aria-hidden="true" />
                <strong style="font-size:12px;color:var(--landing-mist)">Run detail · step timeline</strong>
              </div>
              <span class="pill" style="background:rgba(183,164,251,0.12);border-color:rgba(183,164,251,0.22);color:var(--landing-lilac);font-size:11px">running · pinned v3</span>
            </div>
            <div style="display:grid;gap:12px">
              <div style="display:flex;gap:12px;align-items:center;padding:12px;border-radius:12px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border)">
                <span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:rgba(139,245,201,0.14);color:var(--landing-mint);border:1px solid rgba(139,245,201,0.22)">✓</span>
                <div style="flex:1">
                  <div style="display:flex;justify-content:space-between"><strong style="font-size:12px;color:var(--landing-mist)">trigger · stripe</strong><span style="font-size:11px;color:var(--landing-faint)">41ms</span></div>
                  <p style="margin:2px 0 0;color:var(--landing-faint);font-size:11px">payload summary · webhook received</p>
                </div>
              </div>
              <div style="height:1px;background:var(--landing-border);margin-left:14px" aria-hidden="true" />
              <div style="display:flex;gap:12px;align-items:center;padding:12px;border-radius:12px;background:rgba(183,164,251,0.08);border:1px solid rgba(183,164,251,0.22)">
                <span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:rgba(183,164,251,0.14);color:var(--landing-lilac);border:1px solid rgba(183,164,251,0.22)">◷</span>
                <div style="flex:1">
                  <div style="display:flex;justify-content:space-between"><strong style="font-size:12px;color:var(--landing-mist)">llm · classify</strong><span style="font-size:11px;color:var(--landing-lilac)">128 tok · 420ms</span></div>
                  <p style="margin:2px 0 0;color:var(--landing-faint);font-size:11px">attempt 1 · anthropic · context summarized</p>
                </div>
              </div>
              <div style="height:1px;background:var(--landing-border);margin-left:14px" aria-hidden="true" />
              <div style="display:flex;gap:12px;align-items:center;padding:12px;border-radius:12px;background:rgba(255,255,255,0.02);border:1px solid var(--landing-border);opacity:0.7">
                <span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:rgba(255,255,255,0.06);color:var(--landing-faint)">•</span>
                <div style="flex:1">
                  <div style="display:flex;justify-content:space-between"><strong style="font-size:12px;color:var(--landing-faint)">tool · send_slack_message</strong><span style="font-size:11px;color:var(--landing-faint)">queued</span></div>
                  <p style="margin:2px 0 0;color:var(--landing-faint);font-size:11px">lease pending · toolRounds preview</p>
                </div>
              </div>
            </div>
            <div style="margin-top:14px;padding:10px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid var(--landing-border);font-size:11px;color:var(--landing-faint)">Illustrative · every step, job and LLM round is queryable via API — summaries are redacted by design.</div>
          </div>

          <!-- workflow catalog -->
          <div class="bento-card reveal" style="--delay:80ms;grid-column:span 2">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
              <strong style="font-size:12px;color:var(--landing-mist)">Workflows · tenant catalog</strong>
              <span class="pill" style="background:rgba(255,255,255,0.06);border-color:var(--landing-border);color:var(--landing-faint);font-size:11px">20 per page</span>
            </div>
            <div style="display:grid;gap:8px">
              <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border)"><span style="font-size:13px;color:var(--landing-mist);font-weight:500">invoice-triage</span><span class="status-badge" style="height:20px;background:rgba(139,245,201,0.12);color:var(--landing-mint);border:1px solid rgba(139,245,201,0.22)">active</span></div>
              <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-radius:10px;background:rgba(255,255,255,0.02);border:1px solid var(--landing-border)"><span style="font-size:13px;color:var(--landing-dim)">lead-enrich</span><span class="status-badge" style="height:20px;background:rgba(255,255,255,0.06);color:var(--landing-faint);border:1px solid var(--landing-border)">draft</span></div>
              <div style="display:flex;justify-content:space-between;align-items:center;padding:12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border)"><span style="font-size:13px;color:var(--landing-mist);font-weight:500">slack-ops</span><span class="status-badge" style="height:20px;background:rgba(139,245,201,0.12);color:var(--landing-mint);border:1px solid rgba(139,245,201,0.22)">active</span></div>
            </div>
          </div>

          <!-- connections -->
          <div class="bento-card reveal" style="--delay:120ms;grid-column:span 2">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
              <strong style="font-size:12px;color:var(--landing-mist)">Connections · encrypted at rest</strong>
              <span style="color:var(--landing-mint);font-size:11px;font-weight:600">● secure</span>
            </div>
            <div style="display:grid;gap:8px">
              <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border)"><span style="color:var(--landing-mist);font-size:13px">Slack · prod-slack</span><span class="status-badge" style="height:20px;background:rgba(139,245,201,0.12);color:var(--landing-mint);border:1px solid rgba(139,245,201,0.22)">active</span></div>
              <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid var(--landing-border)"><span style="color:var(--landing-mist);font-size:13px">Anthropic · main-llm</span><span class="status-badge" style="height:20px;background:rgba(139,245,201,0.12);color:var(--landing-mint);border:1px solid rgba(139,245,201,0.22)">active</span></div>
            </div>
            <p style="margin:10px 0 0;color:var(--landing-faint);font-size:11px">Credential values never rendered — metadata only, AES-256-GCM envelope.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- How it works -->
    <section id="how-it-works" class="landing-section">
      <div class="landing-inner">
        <p class="eyebrow-landing">How it works</p>
        <h2 class="section-title">Connect → Define → Trigger → Inspect.</h2>
        <div class="timeline">
          <div class="timeline-step card-sheen reveal"><div class="timeline-num">1</div><h3>Connect your tools</h3><p>Store provider credentials as encrypted connections. Use them via workflows, never pasted secrets.</p></div>
          <div class="timeline-step card-sheen reveal" style="--delay:60ms"><div class="timeline-num">2</div><h3>Define the workflow</h3><p>Author linear steps, set the webhook source, activate a version. In-flight runs stay pinned.</p></div>
          <div class="timeline-step card-sheen reveal" style="--delay:120ms"><div class="timeline-num">3</div><h3>Trigger the automation</h3><p>External system POSTs to <code>/v1/webhooks/:source</code> — captured idempotently via X-Event-ID or body hash.</p></div>
          <div class="timeline-step card-sheen reveal" style="--delay:180ms"><div class="timeline-num">4</div><h3>Inspect the result</h3><p>Open <code>/runs/:runId</code> for steps, jobs, LLM usage and tool activity — redacted, not dumped.</p></div>
        </div>
      </div>
    </section>

    <!-- Reliability -->
    <section class="landing-section">
      <div class="landing-inner">
        <p class="eyebrow-landing">Reliability & control</p>
        <h2 class="section-title">Built as an operations system — not a chatbot wrapper.</h2>
        <div class="bento-grid">
          <article class="bento-card reveal"><h3>Durable jobs</h3><p>PostgreSQL + SELECT … FOR UPDATE SKIP LOCKED. One ready job at a time, safely across workers.</p></article>
          <article class="bento-card reveal" style="--delay:50ms"><h3>Leases & reaper</h3><p>15-minute leases derived from actual step timeouts. Expired leases requeued atomically.</p></article>
          <article class="bento-card reveal" style="--delay:100ms"><h3>Retries</h3><p>Equal-jitter backoff, max attempts respected, terminal failures surfaced with codes.</p></article>
          <article class="bento-card reveal"><h3>Inspectable</h3><p>Every step run, job, and LLM round is queryable — with redaction by default.</p></article>
          <article class="bento-card reveal" style="--delay:50ms"><h3>Isolated tenants</h3><p>Workflows, runs, connections cannot leak across tenants — miss is always 404.</p></article>
          <article class="bento-card reveal" style="--delay:100ms"><h3>Encrypted at rest</h3><p>Connection credentials use AES-256-GCM envelope, never rendered in UI.</p></article>
        </div>
      </div>
    </section>

    <!-- Philosophy -->
    <section class="landing-section">
      <div class="landing-inner">
        <div class="cta-panel reveal product-surface" style="grid-template-columns:1fr;padding:32px">
          <div>
            <p class="eyebrow-landing" style="color:var(--landing-dim)">Product philosophy</p>
            <h2 style="max-width:22ch;color:var(--landing-mist);font-size:28px;letter-spacing:-0.03em">Built for people who want work to run itself.</h2>
            <p style="color:var(--landing-dim)">No fake logos, no inflated metrics. AI Workforce earns trust by showing what actually happened — every trigger, step, and tool call — and letting teams automate the rest.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- FAQ -->
    <section id="faq" class="landing-section">
      <div class="landing-inner">
        <p class="eyebrow-landing">FAQ</p>
        <h2 class="section-title">Truthful answers from the actual product.</h2>
        <div class="faq-grid">
          <details class="faq-item card-sheen"><summary>What is AI Workforce? <span aria-hidden="true">+</span></summary><p>An operations automation platform: define workflows, trigger via webhook, execute steps (including LLM), use connected tools, and inspect runs.</p></details>
          <details class="faq-item card-sheen"><summary>What can I automate? <span aria-hidden="true">+</span></summary><p>Repetitive ops: triage, enrichment, notifications, and any linear workflow the engine can express. Steps are <code>noop</code> and <code>llm</code> today, with tool support (e.g. Slack) via connections.</p></details>
          <details class="faq-item card-sheen"><summary>How do workflows get triggered? <span aria-hidden="true">+</span></summary><p>Currently via <code>POST /v1/webhooks/:source</code> under bearer auth (API key). Webhook HMAC verification is rawBody-ready but not enforced yet — provider webhooks must use bearer until per-provider verification lands.</p></details>
          <details class="faq-item card-sheen"><summary>Can workflows use AI? <span aria-hidden="true">+</span></summary><p>Yes. <code>llm</code> steps via Anthropic provider — text and structured output, normalized usage/latency. Non-AI steps run deterministically.</p></details>
          <details class="faq-item card-sheen"><summary>How are connections secured? <span aria-hidden="true">+</span></summary><p>Credentials are encrypted at rest and never returned by <code>GET /v1/connections</code>. The UI shows only provider, name, status and metadata counts.</p></details>
          <details class="faq-item card-sheen"><summary>Can I inspect executions? <span aria-hidden="true">+</span></summary><p>Yes — <code>GET /v1/runs</code> and <code>GET /v1/runs/:runId</code> (same redacted DTO as CLI). Steps, jobs, LLM usage and tool activity are all visible.</p></details>
        </div>
      </div>
    </section>

    <!-- Final CTA -->
    <section class="landing-section" style="padding-top:32px">
      <div class="landing-inner">
        <div class="cta-panel reveal product-surface" style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:32px;align-items:center;padding:32px">
          <div>
            <h2 style="color:var(--landing-mist)">Stop doing work your workflows can do.</h2>
            <p style="color:var(--landing-dim)">Explore the live workspace — workflows, runs and connections are real API-backed collections, not screenshots.</p>
          </div>
          <div class="cta-actions" style="justify-content:flex-end">
            <NuxtLink to="/workflows" class="button button-primary btn-shine" style="background:var(--landing-mist);color:var(--landing-void);border-radius:999px">Start building <span class="shine-strip" aria-hidden="true" /></NuxtLink>
            <a href="#capabilities" class="button button-secondary" style="border-radius:999px;background:transparent;color:var(--landing-mist);border-color:var(--landing-border)">Explore the platform</a>
          </div>
        </div>
      </div>
    </section>

    <footer class="landing-footer">
      <div class="landing-inner">
        <div class="footer-grid">
          <div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><span class="landing-brand-mark" style="width:28px;height:28px">◈</span><strong style="color:var(--landing-mist)">AI Workforce</strong></div>
            <p style="color:var(--landing-dim);font-size:13px;line-height:1.6;max-width:32ch">An AI-powered operations automation platform. Workflows, webhooks, AI execution and visible runs — under your control.</p>
          </div>
          <div>
            <strong>Product</strong>
            <NuxtLink to="/workflows">Workflows</NuxtLink>
            <NuxtLink to="/runs">Runs</NuxtLink>
            <NuxtLink to="/connections">Connections</NuxtLink>
            <a href="#how-it-works">How it works</a>
          </div>
          <div>
            <strong>Resources</strong>
            <a href="https://github.com/Vansh-22f300/Automation" target="_blank" rel="noreferrer">GitHub</a>
            <a href="#faq">FAQ</a>
            <span style="color:var(--landing-faint);font-size:13px">No fake docs — API is the source of truth.</span>
          </div>
        </div>
        <div class="footer-bottom" style="border-color:var(--landing-border)">
          <span>© {{ year }} AI Workforce. No fake claims. No fake testimonials.</span>
          <span style="color:var(--landing-faint)">Geist · Linear × Vercel inspired, not copied</span>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
code { font-family: var(--font-mono); font-size: 12px; background: rgba(255,255,255,0.06); border: 1px solid var(--landing-border); padding: 1px 6px; border-radius: 6px; color: var(--landing-mist); }
</style>
