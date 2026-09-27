<script setup lang="ts">
import { Activity, Lock } from "@lucide/vue";
import { ref } from "vue";
import { ApiClientError } from "~/lib/api-client";

definePageMeta({ layout: "auth" });

const { resetPassword } = useAuth();
const route = useRoute();

// The GET handoff redirects here with `?status=invalid` when the email link
// carried no token (nothing was stashed in the HttpOnly cookie), so there is
// nothing to reset — show the dead-link state immediately, no form.
type Mode = "form" | "done" | "invalid";
const mode = ref<Mode>(route.query.status === "invalid" ? "invalid" : "form");

const password = ref("");
const confirm = ref("");
const pending = ref(false);
const errorMessage = ref("");

async function onSubmit(): Promise<void> {
  if (pending.value) return;
  errorMessage.value = "";
  if (password.value.length < 8) {
    errorMessage.value = "Use a password of at least 8 characters.";
    return;
  }
  if (password.value !== confirm.value) {
    errorMessage.value = "The two passwords don't match.";
    return;
  }
  pending.value = true;
  try {
    // Only the new password is sent; the one-time token lives in the HttpOnly
    // cookie and is read server-side by the BFF — the browser never sees it.
    await resetPassword(password.value);
    mode.value = "done";
  } catch (caught) {
    if (caught instanceof ApiClientError && caught.status === 0) {
      // Transient network failure — the token is still live, so let them retry.
      errorMessage.value = caught.message;
    } else {
      // 400/401/etc: the token is invalid, expired, or already spent.
      mode.value = "invalid";
    }
  } finally {
    pending.value = false;
    password.value = "";
    confirm.value = "";
  }
}
</script>

<template>
  <section class="panel auth-card" aria-labelledby="reset-title">
    <div class="auth-brand">
      <span class="auth-brand-mark" aria-hidden="true"><Activity :size="18" /></span>
      <div class="auth-brand-copy">
        <strong>AI Workforce</strong>
        <span>Operations workspace</span>
      </div>
    </div>

    <template v-if="mode === 'done'">
      <h1 id="reset-title" class="auth-title">Password updated</h1>
      <p class="auth-note" role="status">
        Your password has been reset and you've been signed out everywhere. Sign in
        with your new password to continue.
      </p>
      <NuxtLink to="/login" class="button button-primary auth-submit">Go to sign in</NuxtLink>
    </template>

    <template v-else-if="mode === 'invalid'">
      <h1 id="reset-title" class="auth-title">Link expired</h1>
      <p class="auth-subtitle">
        This password reset link is invalid or has expired. Request a fresh one to
        try again.
      </p>
      <NuxtLink to="/forgot-password" class="button button-primary auth-submit">
        Request a new link
      </NuxtLink>
    </template>

    <template v-else>
      <h1 id="reset-title" class="auth-title">Choose a new password</h1>
      <p class="auth-subtitle">Set a new password for your account.</p>

      <form class="auth-form" novalidate @submit.prevent="onSubmit">
        <div>
          <label class="field-label auth-label" for="reset-password">New password</label>
          <div class="lookup-control">
            <Lock :size="15" aria-hidden="true" />
            <input
              id="reset-password"
              v-model="password"
              type="password"
              name="password"
              autocomplete="new-password"
              :disabled="pending"
              :aria-invalid="errorMessage !== '' ? 'true' : undefined"
              :aria-describedby="errorMessage !== '' ? 'reset-error' : 'reset-hint'"
              placeholder="At least 8 characters"
            />
          </div>
          <p id="reset-hint" class="auth-hint">Use at least 8 characters.</p>
        </div>
        <div>
          <label class="field-label auth-label" for="reset-confirm">Confirm password</label>
          <div class="lookup-control">
            <Lock :size="15" aria-hidden="true" />
            <input
              id="reset-confirm"
              v-model="confirm"
              type="password"
              name="confirmPassword"
              autocomplete="new-password"
              :disabled="pending"
              :aria-invalid="errorMessage !== '' ? 'true' : undefined"
              placeholder="Re-enter your new password"
            />
          </div>
        </div>

        <p v-if="errorMessage" id="reset-error" class="auth-error" role="alert">{{ errorMessage }}</p>

        <button class="button button-primary auth-submit" type="submit" :disabled="pending">
          {{ pending ? "Updating…" : "Update password" }}
        </button>
      </form>
    </template>

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
.auth-title { margin: 0; font-size: 20px; letter-spacing: -0.02em; color: var(--landing-mist); }
.auth-subtitle { margin: 6px 0 20px; font-size: 13px; color: var(--landing-dim); }
.auth-form { display: grid; gap: 14px; }
.auth-label { color: var(--landing-dim); }
.auth-card .lookup-control { max-width: none; width: 100%; }
.auth-hint { margin: 6px 2px 0; font-size: 11px; color: var(--landing-faint); }
.auth-error {
  margin: 0; font-size: 12px; color: var(--landing-danger);
  padding: 8px 10px; border-radius: 8px;
  background: rgba(255,107,107,0.10); border: 1px solid rgba(255,107,107,0.22);
}
.auth-note {
  margin: 0 0 14px; font-size: 13px; color: var(--landing-mist); line-height: 1.5;
  padding: 12px 14px; border-radius: 10px;
  background: rgba(139,245,201,0.08); border: 1px solid rgba(139,245,201,0.20);
}
.auth-submit { width: 100%; margin-top: 2px; text-align: center; }
.auth-back {
  display: inline-block; margin-top: 10px; font-size: 12px; color: var(--landing-faint);
}
.auth-back:hover { color: var(--landing-mist); }
</style>
