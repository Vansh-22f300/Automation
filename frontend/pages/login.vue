<script setup lang="ts">
import { Activity, Lock, Mail } from "@lucide/vue";
import { ref } from "vue";
import { ApiClientError } from "~/lib/api-client";

definePageMeta({ layout: "auth" });

const { login } = useAuth();
const route = useRoute();
const router = useRouter();

const email = ref("");
const password = ref("");
const pending = ref(false);
const errorMessage = ref("");

// Only follow same-app absolute paths — never an off-site or protocol-relative
// `redirect` query (open-redirect guard).
function redirectTarget(): string {
  const target = route.query.redirect;
  if (typeof target === "string" && target.startsWith("/") && !target.startsWith("//")) {
    return target;
  }
  return "/workflows";
}

// Generic, status-shaped messages only: never reveal which field was wrong, and
// never surface tenant identifiers from a tenant-selection (409) response.
function messageFor(caught: unknown): string {
  if (caught instanceof ApiClientError) {
    switch (caught.status) {
      case 401:
        return "Invalid email or password.";
      case 429:
        return "Too many attempts. Please wait a moment and try again.";
      case 409:
        return "Your account needs additional setup. Contact your administrator.";
      case 0:
        return caught.message;
    }
  }
  return "Sign-in could not be completed. Please try again.";
}

async function onSubmit(): Promise<void> {
  if (pending.value) return;
  errorMessage.value = "";
  if (email.value.trim() === "" || password.value === "") {
    errorMessage.value = "Enter your email and password.";
    return;
  }
  pending.value = true;
  try {
    await login(email.value.trim(), password.value);
    await router.replace(redirectTarget());
  } catch (caught) {
    errorMessage.value = messageFor(caught);
    password.value = "";
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <section class="panel auth-card" aria-labelledby="login-title">
    <div class="auth-brand">
      <span class="auth-brand-mark" aria-hidden="true"><Activity :size="18" /></span>
      <div class="auth-brand-copy">
        <strong>AI Workforce</strong>
        <span>Operations workspace</span>
      </div>
    </div>
    <h1 id="login-title" class="auth-title">Sign in</h1>
    <p class="auth-subtitle">Use your workspace credentials to continue.</p>

    <form class="auth-form" novalidate @submit.prevent="onSubmit">
      <div>
        <label class="field-label auth-label" for="login-email">Email</label>
        <div class="lookup-control">
          <Mail :size="15" aria-hidden="true" />
          <input
            id="login-email"
            v-model="email"
            type="email"
            name="email"
            autocomplete="username"
            inputmode="email"
            :disabled="pending"
            :aria-invalid="errorMessage !== '' ? 'true' : undefined"
            placeholder="you@example.com"
          />
        </div>
      </div>
      <div>
        <label class="field-label auth-label" for="login-password">Password</label>
        <div class="lookup-control">
          <Lock :size="15" aria-hidden="true" />
          <input
            id="login-password"
            v-model="password"
            type="password"
            name="password"
            autocomplete="current-password"
            :disabled="pending"
            :aria-invalid="errorMessage !== '' ? 'true' : undefined"
            :aria-describedby="errorMessage !== '' ? 'login-error' : undefined"
            placeholder="••••••••"
          />
        </div>
      </div>

      <p v-if="errorMessage" id="login-error" class="auth-error" role="alert">{{ errorMessage }}</p>

      <button class="button button-primary auth-submit" type="submit" :disabled="pending">
        {{ pending ? "Signing in…" : "Sign in" }}
      </button>
    </form>

    <NuxtLink to="/" class="auth-back">&larr; Back to overview</NuxtLink>
  </section>
</template>

<style scoped>
.auth-card { width: 100%; max-width: 400px; }
.auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
.auth-brand-mark {
  display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px;
  background: var(--landing-mist); color: var(--landing-void); flex: 0 0 auto;
}
.auth-brand-copy { display: flex; flex-direction: column; line-height: 1.2; }
.auth-brand-copy strong { font-size: 14px; letter-spacing: -0.01em; }
.auth-brand-copy span { font-size: 11px; color: var(--landing-faint); }
.auth-title { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
.auth-subtitle { margin: 6px 0 20px; font-size: 13px; color: var(--landing-dim); }
.auth-form { display: grid; gap: 14px; }
.auth-label { color: var(--landing-dim); }
.auth-card .lookup-control { max-width: none; width: 100%; }
.auth-error {
  margin: 0; font-size: 12px; color: var(--landing-danger);
  padding: 8px 10px; border-radius: 8px;
  background: rgba(255,107,107,0.10); border: 1px solid rgba(255,107,107,0.22);
}
.auth-submit { width: 100%; margin-top: 2px; }
.auth-back {
  display: inline-block; margin-top: 18px; font-size: 12px; color: var(--landing-faint);
}
.auth-back:hover { color: var(--landing-mist); }
</style>
