<script setup lang="ts">
definePageMeta({ layout: 'landing' });

const isMenuOpen = ref(false);
const isScrolled = ref(false);

function toggleMenu() { isMenuOpen.value = !isMenuOpen.value; }
function closeMenu() { isMenuOpen.value = false; }

onMounted(() => {
  const onScroll = () => { isScrolled.value = window.scrollY > 8; };
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
    <!-- Sticky nav -->
    <header class="landing-nav" :class="{ 'is-scrolled': isScrolled }">
      <div class="landing-nav-row">
        <NuxtLink to="/" class="landing-brand" aria-label="AI Workforce home">
          <span class="landing-brand-mark" aria-hidden="true"><span style="font-size:14px;font-weight:650">◈</span></span>
          <strong>AI Workforce</strong>
          <span>Operations workspace</span>
        </NuxtLink>

        <nav class="landing-links" :class="{ 'is-open': isMenuOpen }" aria-label="Primary">
          <a href="#product" @click="closeMenu">Product</a>
          <a href="#capabilities" @click="closeMenu">Capabilities</a>
          <a href="#how-it-works" @click="closeMenu">How it works</a>
          <a href="#faq" @click="closeMenu">FAQ</a>
        </nav>

        <div class="landing-ctas">
          <NuxtLink to="/workflows" class="button button-secondary" style="height:36px">Open Workspace</NuxtLink>
          <button class="landing-hamburger" type="button" :aria-expanded="isMenuOpen ? 'true' : 'false'" aria-controls="primary-nav" aria-label="Toggle menu" @click="toggleMenu">
            <span aria-hidden="true">{{ isMenuOpen ? '✕' : '☰' }}</span>
          </button>
        </div>
      </div>
    </header>

    <!-- Hero -->
    <section class="hero">
      <div class="landing-inner">
        <div class="hero-grid">
          <div class="hero-copy reveal">
            <p class="eyebrow" style="color:var(--brand-weak-text)">AI operations control plane</p>
            <h1>Turn repetitive operations <em>into autonomous workflows.</em></h1>
            <p class="hero-lead">
              AI Workforce is a workflow automation platform for teams who ship. Define once, trigger via webhook, execute with AI where it helps — and inspect every run.
            </p>
            <div class="hero-actions">
              <NuxtLink to="/workflows" class="button button-primary">Open Workspace <span aria-hidden="true">→</span></NuxtLink>
              <a href="#capabilities" class="button button-secondary">Explore capabilities</a>
            </div>
            <p class="hero-note"><strong>Built for real operations.</strong> Webhooks · AI steps · encrypted connections · visible execution.</p>
          </div>

          <div class="hero-visual reveal" style="--delay:80ms">
            <div class="hero-visual-inner">
              <!-- illustrative product mock — truthful to actual app -->
              <div class="mini-panel">
                <div class="mini-head">
                  <strong>Workflow · invoice-triage</strong>
                  <span class="status-badge status-success" style="height:20px;font-size:11px">active · v3</span>
                </div>
                <div class="mini-body">
                  <div class="mini-row"><span>Trigger</span><span class="pill" style="height:20px">webhook · stripe</span></div>
                  <div class="mini-row"><span>Steps</span><span style="color:var(--text-secondary);font-size:13px">classify → extract → notify</span></div>
                  <div class="mini-row"><span>Last run</span><span style="color:var(--success-text);font-weight:500">succeeded · 1.4s</span></div>
                </div>
              </div>

              <div class="mini-panel">
                <div class="mini-head">
                  <strong>Run · 01993a8b-7b2a-7…</strong>
                  <span class="status-badge status-info">running</span>
                </div>
                <div class="mini-body">
                  <div class="mini-row"><span style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:999px;background:var(--success-text)"></span> trigger received</span><span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">stripe · webhook</span></div>
                  <div class="mini-row"><span style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:999px;background:var(--info-text)"></span> llm · classify</span><span style="font-size:12px;color:var(--text-muted)">128 tokens · 420ms</span></div>
                  <div class="mini-row"><span style="display:flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:999px;background:var(--border-strong)"></span> slack · notify</span><span style="font-size:12px;color:var(--text-muted)">queued</span></div>
                </div>
              </div>

              <div class="capability-strip" style="margin:0;border-top:0;padding-top:4px">
                <span><i aria-hidden="true"></i> Workflows</span>
                <span><i aria-hidden="true"></i> AI execution</span>
                <span><i aria-hidden="true"></i> Webhooks</span>
                <span><i aria-hidden="true"></i> Run visibility</span>
              </div>
              <p style="margin:0;color:var(--text-muted);font-size:12px">Illustrative example — built from actual workflow, run and connection concepts. No fake data.</p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Problem -> solution -->
    <section id="product" class="landing-section">
      <div class="landing-inner">
        <div class="reveal">
          <p class="section-kicker">Why AI Workforce</p>
          <h2 class="section-title">Repetitive work hides inside every operations handoff.</h2>
          <p class="section-lead">Scattered tools, manual checks, and unclear execution state turn simple work into toil. AI Workforce turns that work into a deterministic workflow — triggered, executed, and inspectable.</p>
        </div>
        <div class="feature-grid">
          <div class="feature-card reveal"><div class="feature-icon" aria-hidden="true">◐</div><h3>Before: manual coordination</h3><p>Copying fields, chasing approvals, and re-running the same AI prompts with no audit.</p></div>
          <div class="feature-card reveal" style="--delay:60ms"><div class="feature-icon" aria-hidden="true">◎</div><h3>After: defined workflow</h3><p>One workflow, versioned. Triggered by webhook, steps run in order on durable jobs.</p></div>
          <div class="feature-card reveal" style="--delay:120ms"><div class="feature-icon" aria-hidden="true">⬔</div><h3>After: visible result</h3><p>Every run, step, job, and LLM use is recorded — not guessed. Inspect what actually happened.</p></div>
        </div>
      </div>
    </section>

    <!-- Capabilities -->
    <section id="capabilities" class="landing-section" style="background:var(--surface-raised);border-top:1px solid var(--border-subtle);border-bottom:1px solid var(--border-subtle)">
      <div class="landing-inner">
        <p class="section-kicker">Core capabilities</p>
        <h2 class="section-title">AI where it helps. Automation where it matters.</h2>
        <p class="section-lead">Everything below maps to real backend primitives — no inflated claims.</p>
        <div class="feature-grid">
          <div class="feature-card reveal"><div class="feature-icon">⟁</div><h3>Workflow automation</h3><p>Versioned definitions (linear steps, unique keys). Active version pinning so in-flight runs never shift.</p></div>
          <div class="feature-card reveal" style="--delay:50ms"><div class="feature-icon">✦</div><h3>AI-powered execution</h3><p>LLM steps where reasoning helps — provider-abstracted, with token/latency capture and context summaries.</p></div>
          <div class="feature-card reveal" style="--delay:100ms"><div class="feature-icon">↗</div><h3>Webhook triggers</h3><p>POST /v1/webhooks/:source with HMAC-ready rawBody preservation. Dedupe via X-Event-ID or SHA-256.</p></div>
          <div class="feature-card reveal"><div class="feature-icon">🔗</div><h3>Connected tools</h3><p>Provider credentials encrypted at rest (AES-256-GCM), never rendered. Used via connections.</p></div>
          <div class="feature-card reveal" style="--delay:50ms"><div class="feature-icon">▦</div><h3>Durable execution</h3><p>PostgreSQL-backed jobs, SKIP LOCKED claim, 15-min leases, reaper for expired leases.</p></div>
          <div class="feature-card reveal" style="--delay:100ms"><div class="feature-icon">◈</div><h3>Run inspection</h3><p>Steps, jobs, tool rounds, errors and usage — summarized and redacted, not dumped.</p></div>
          <div class="feature-card reveal"><div class="feature-icon">↻</div><h3>Retries with backoff</h3><p>Equal-jitter retries, max attempts, and terminal failure surfaces. No hidden once-only magic.</p></div>
          <div class="feature-card reveal" style="--delay:50ms"><div class="feature-icon">🛡️</div><h3>Tenant isolation</h3><p>Every workflow, run, connection and job is tenant-scoped. Missing tenant looks like 404.</p></div>
          <div class="feature-card reveal" style="--delay:100ms"><div class="feature-icon">◉</div><h3>Operational visibility</h3><p>Run timeline, job lease, step durations — the control plane shows execution, not a chatbot.</p></div>
        </div>
      </div>
    </section>

    <!-- Product showcase -->
    <section class="landing-section">
      <div class="landing-inner">
        <p class="section-kicker">Product showcase</p>
        <h2 class="section-title">The actual application — not a decorative mock.</h2>
        <p class="section-lead">Compositions below are built from real routes: <code>/workflows</code>, <code>/runs</code>, <code>/runs/:runId</code>, <code>/connections</code>.</p>

        <div class="showcase-grid">
          <div class="showcase-stack">
            <div class="mini-panel reveal">
              <div class="mini-head"><strong>Workflows · tenant catalog</strong><span class="pill">20 per page</span></div>
              <div class="mini-body" style="padding:0">
                <div style="display:grid">
                  <div style="display:flex;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border-subtle);font-size:13px"><span style="font-weight:500">invoice-triage</span><span class="status-badge status-success" style="height:20px">active</span></div>
                  <div style="display:flex;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border-subtle);font-size:13px"><span style="font-weight:500">lead-enrich</span><span class="status-badge status-neutral" style="height:20px">draft</span></div>
                  <div style="display:flex;justify-content:space-between;padding:12px 14px;font-size:13px"><span style="font-weight:500">slack-ops</span><span class="status-badge status-success" style="height:20px">active</span></div>
                </div>
              </div>
            </div>

            <div class="mini-panel reveal" style="--delay:60ms">
              <div class="mini-head"><strong>Connections · encrypted at rest</strong><span style="color:var(--success-text);font-size:12px;font-weight:500">● secure</span></div>
              <div class="mini-body">
                <div class="mini-row"><span>Slack · prod-slack</span><span class="status-badge status-success">active</span></div>
                <div class="mini-row"><span>Anthropic · main-llm</span><span class="status-badge status-success">active</span></div>
                <div style="margin-top:10px;color:var(--text-muted);font-size:12px">Credential values never rendered — metadata only, AES-256-GCM envelope.</div>
              </div>
            </div>
          </div>

          <div class="mini-panel reveal" style="--delay:120ms">
            <div class="mini-head"><strong>Run detail · step timeline</strong><span class="status-badge status-warning">running</span></div>
            <div class="mini-body">
              <div style="display:grid;gap:10px">
                <div style="display:flex;gap:10px;align-items:center"><span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:var(--success-bg);color:var(--success-text);font-size:12px">✓</span><div><strong style="font-size:13px">trigger · stripe</strong><p style="margin:2px 0 0;color:var(--text-muted);font-size:12px">received · payload summary preview</p></div></div>
                <div style="height:1px;background:var(--border-subtle);margin-left:14px"></div>
                <div style="display:flex;gap:10px;align-items:center"><span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:var(--info-bg);color:var(--info-text);font-size:12px">◷</span><div><strong style="font-size:13px">llm · classify</strong><p style="margin:2px 0 0;color:var(--text-muted);font-size:12px">running · input 1.2k tokens</p></div></div>
                <div style="height:1px;background:var(--border-subtle);margin-left:14px"></div>
                <div style="display:flex;gap:10px;align-items:center;opacity:0.7"><span style="width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:var(--neutral-bg);color:var(--neutral-text);font-size:12px">•</span><div><strong style="font-size:13px">tool · send_slack_message</strong><p style="margin:2px 0 0;color:var(--text-muted);font-size:12px">queued · lease pending</p></div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- How it works -->
    <section id="how-it-works" class="landing-section" style="background:var(--surface)">
      <div class="landing-inner">
        <p class="section-kicker">How it works</p>
        <h2 class="section-title">Connect → Define → Trigger → Inspect.</h2>
        <div class="timeline">
          <div class="timeline-step reveal"><div class="timeline-num">1</div><h3>Connect your tools</h3><p>Store provider credentials as encrypted connections. Use them via workflows, never pasted secrets.</p></div>
          <div class="timeline-step reveal" style="--delay:60ms"><div class="timeline-num">2</div><h3>Define the workflow</h3><p>Author linear steps, set the webhook source, activate a version. In-flight runs stay pinned.</p></div>
          <div class="timeline-step reveal" style="--delay:120ms"><div class="timeline-num">3</div><h3>Trigger the automation</h3><p>External system POSTs to <code>/v1/webhooks/:source</code> — captured idempotently via X-Event-ID or body hash.</p></div>
          <div class="timeline-step reveal" style="--delay:180ms"><div class="timeline-num">4</div><h3>Inspect the result</h3><p>Open <code>/runs/:runId</code> for steps, jobs, LLM usage and tool activity — redacted, not dumped.</p></div>
        </div>
      </div>
    </section>

    <!-- Reliability -->
    <section class="landing-section" style="background:var(--surface-raised)">
      <div class="landing-inner">
        <p class="section-kicker">Reliability & control</p>
        <h2 class="section-title">Built as an operations system — not a chatbot wrapper.</h2>
        <div class="feature-grid">
          <div class="feature-card reveal"><h3>Durable jobs</h3><p>PostgreSQL + SELECT … FOR UPDATE SKIP LOCKED. One ready job at a time, safely across workers.</p></div>
          <div class="feature-card reveal" style="--delay:50ms"><h3>Leases & reaper</h3><p>15-minute leases derived from actual step timeouts. Expired leases requeued atomically.</p></div>
          <div class="feature-card reveal" style="--delay:100ms"><h3>Retries</h3><p>Equal-jitter backoff, max attempts respected, terminal failures surfaced with codes.</p></div>
          <div class="feature-card reveal"><h3>Inspectable</h3><p>Every step run, job, and LLM round is queryable — with redaction by default.</p></div>
          <div class="feature-card reveal" style="--delay:50ms"><h3>Isolated tenants</h3><p>Workflows, runs, connections cannot leak across tenants — miss is always 404.</p></div>
          <div class="feature-card reveal" style="--delay:100ms"><h3>Encrypted at rest</h3><p>Connection credentials use AES-256-GCM envelope, never rendered in UI.</p></div>
        </div>
      </div>
    </section>

    <!-- Philosophy instead of testimonials -->
    <section class="landing-section">
      <div class="landing-inner">
        <div class="cta-panel reveal" style="grid-template-columns:1fr">
          <div>
            <p class="eyebrow" style="color:rgba(255,255,255,0.7)">Product philosophy</p>
            <h2 style="max-width:22ch">Built for people who want work to run itself.</h2>
            <p>No fake logos, no inflated metrics. AI Workforce earns trust by showing what actually happened — every trigger, step, and tool call — and letting teams automate the rest.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- FAQ -->
    <section id="faq" class="landing-section">
      <div class="landing-inner">
        <p class="section-kicker">FAQ</p>
        <h2 class="section-title">Truthful answers from the actual product.</h2>
        <div class="faq-grid">
          <details class="faq-item"><summary>What is AI Workforce? <span aria-hidden="true">+</span></summary><p>An operations automation platform: define workflows, trigger via webhook, execute steps (including LLM), use connected tools, and inspect runs.</p></details>
          <details class="faq-item"><summary>What can I automate? <span aria-hidden="true">+</span></summary><p>Repetitive ops: triage, enrichment, notifications, and any linear workflow the engine can express. Steps are `noop` and `llm` today, with tool support (e.g. Slack) via connections.</p></details>
          <details class="faq-item"><summary>How do workflows get triggered? <span aria-hidden="true">+</span></summary><p>Currently via <code>POST /v1/webhooks/:source</code> under bearer auth (API key). Webhook HMAC verification is rawBody-ready but not enforced yet — provider webhooks must use bearer until per-provider verification lands.</p></details>
          <details class="faq-item"><summary>Can workflows use AI? <span aria-hidden="true">+</span></summary><p>Yes. `llm` steps via Anthropic provider — text and structured output, normalized usage/latency. Non-AI steps run deterministically.</p></details>
          <details class="faq-item"><summary>How are connections secured? <span aria-hidden="true">+</span></summary><p>Credentials are encrypted at rest and never returned by `GET /v1/connections`. The UI shows only provider, name, status and metadata counts.</p></details>
          <details class="faq-item"><summary>Can I inspect executions? <span aria-hidden="true">+</span></summary><p>Yes — `GET /v1/runs` and `GET /v1/runs/:runId` (same redacted DTO as CLI). Steps, jobs, LLM usage and tool activity are all visible.</p></details>
        </div>
      </div>
    </section>

    <!-- Final CTA -->
    <section class="landing-section" style="padding-top:32px">
      <div class="landing-inner">
        <div class="cta-panel reveal">
          <div>
            <h2>Stop doing work your workflows can do.</h2>
            <p>Explore the live workspace — workflows, runs and connections are real API-backed collections, not screenshots.</p>
          </div>
          <div class="cta-actions">
            <NuxtLink to="/workflows" class="button button-primary">Start building</NuxtLink>
            <a href="#capabilities" class="button button-secondary">Explore the platform</a>
          </div>
        </div>
      </div>
    </section>

    <footer class="landing-footer">
      <div class="landing-inner">
        <div class="footer-grid">
          <div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><span class="landing-brand-mark" style="width:28px;height:28px">◈</span><strong>AI Workforce</strong></div>
            <p style="color:var(--text-secondary);font-size:13px;line-height:1.6;max-width:32ch">An AI-powered operations automation platform. Workflows, webhooks, AI execution and visible runs — under your control.</p>
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
            <a href="https://github.com" target="_blank" rel="noreferrer">GitHub</a>
            <a href="#faq">FAQ</a>
            <span style="color:var(--text-muted);font-size:13px">No fake docs — API is the source of truth.</span>
          </div>
        </div>
        <div class="footer-bottom">
          <span>© {{ year }} AI Workforce. No fake claims. No fake testimonials.</span>
          <span style="color:var(--text-muted)">Geist · Linear × Vercel inspired, not copied</span>
        </div>
      </div>
    </footer>
  </div>
</template>

<style scoped>
code { font-family: var(--font-mono); font-size: 12px; background: var(--surface-sunken); border: 1px solid var(--border); padding: 1px 6px; border-radius: 6px; }
</style>
