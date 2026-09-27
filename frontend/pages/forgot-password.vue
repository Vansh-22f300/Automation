<script setup lang="ts">
import { Activity, Mail } from "@lucide/vue";
import { ref } from "vue";
import { ApiClientError } from "~/lib/api-client";

definePageMeta({ layout: "auth" });

const { forgotPassword } = useAuth();

const email = ref("");
const pending = ref(false);
const submitted = ref(false);
const errorMessage = ref("");

// The confirmation is deliberately account-agnostic: it is shown for every
// resolved outcome (existing account, unknown email, throttled) so this page can
// never become a user-enumeration oracle. Only a true network failure surfaces a
// distinct, retryable message.
const GENERIC_CONFIRMATION =
  "If an account exists for that address, we've sent password reset instructions. Check your inbox and spam folder.";

async function onSubmit(): Promise<void> {
  if (pending.value) return;
  errorMessage.value = "";
  if (email.value.trim() === "") {
    errorMessage.value = "Enter your email address.";
    return;
  }
  pending.value = true;
  try {
    await forgotPassword(email.value.trim());
    submitted.value = true;
  } catch (caught) {
    // A network failure (status 0) is the only case worth distinguishing; every
    // other resolved status already collapsed to the generic 202 upstream, so we
    // still show success rather than leak anything about the account.
    if (caught instanceof ApiClientError && caught.status === 0) {
      errorMessage.value = caught.message;
    } else {
      submitted.value = true;
    }
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <section class="panel auth-card" aria-labelledby="forgot-title">
    <div class="auth-brand">
      <span class="auth-brand-mark" aria-hidden="true"><Activity :size="18" /></span>
      <div class="auth-brand-copy">
        <strong>AI Workforce</strong>
        <span>Operations workspace</span>
      </div>
    </div>

    <template v-if="submitted">
      <h1 id="forgot-title" class="auth-title">Check your email</h1>
      <p class="auth-note" role="status">{{ GENERIC_CONFIRMATION }}</p>
      <p class="auth-subtitle">
        The link expires after a short window. If it lapses, request a new one.
      </p>
      <NuxtLink to="/login" class="button button-primary auth-submit">Back to sign in</NuxtLink>
    </template>

    <template v-else>
      <h1 id="forgot-title" class="auth-title">Reset your password</h1>
      <p class="auth-subtitle">
        Enter your account email and we'll send a link to set a new password.
      </p>

      <form class="auth-form" novalidate @submit.prevent="onSubmit">
        <div>
          <label class="field-label auth-label" for="forgot-email">Email</label>
          <div class="lookup-control">
            <Mail :size="15" aria-hidden="true" />
            <input
              id="forgot-email"
              v-model="email"
              type="email"
              name="email"
              autocomplete="email"
              inputmode="email"
              :disabled="pending"
              :aria-invalid="errorMessage !== '' ? 'true' : undefined"
              :aria-describedby="errorMessage !== '' ? 'forgot-error' : undefined"
              placeholder="you@example.com"
            />
          </div>
        </div>

        <p v-if="errorMessage" id="forgot-error" class="auth-error" role="alert">{{ errorMessage }}</p>

        <button class="button button-primary auth-submit" type="submit" :disabled="pending">
          {{ pending ? "Sending…" : "Send reset link" }}
        </button>
      </form>

      <p class="auth-alt">
        Remembered it?
        <NuxtLink to="/login">Sign in.</NuxtLink>
      </p>
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
.auth-alt { margin: 18px 0 0; font-size: 12px; color: var(--landing-dim); }
.auth-alt a { color: var(--landing-mist); }
.auth-back {
  display: inline-block; margin-top: 10px; font-size: 12px; color: var(--landing-faint);
}
.auth-back:hover { color: var(--landing-mist); }
</style>
