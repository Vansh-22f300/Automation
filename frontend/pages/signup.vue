<script setup lang="ts">
import { Activity, Building2, Lock, Mail, User } from "@lucide/vue";
import { ref } from "vue";
import { ApiClientError } from "~/lib/api-client";

definePageMeta({ layout: "auth" });

const { signup } = useAuth();
const route = useRoute();
const router = useRouter();

const name = ref("");
const email = ref("");
const password = ref("");
const workspaceName = ref("");
const pending = ref(false);
const errorMessage = ref("");

// Only follow same-app absolute paths — never an off-site or protocol-relative
// `redirect` query (open-redirect guard). Signup normally lands on the workspace.
function redirectTarget(): string {
  const target = route.query.redirect;
  if (typeof target === "string" && target.startsWith("/") && !target.startsWith("//")) {
    return target;
  }
  return "/workflows";
}

// Generic, status-shaped messages only. A duplicate email returns 409 from the
// backend as a deliberately non-committal "cannot be used" — mirrored here so the
// signup form is never a user-enumeration oracle (never "that email exists").
function messageFor(caught: unknown): string {
  if (caught instanceof ApiClientError) {
    switch (caught.status) {
      case 409:
        return "That email address can't be used to create an account.";
      case 400:
        return "Please check your details and try again.";
      case 429:
        return "Too many attempts. Please wait a moment and try again.";
      case 0:
        return caught.message;
    }
  }
  return "Sign-up could not be completed. Please try again.";
}

async function onSubmit(): Promise<void> {
  if (pending.value) return;
  errorMessage.value = "";
  if (
    name.value.trim() === "" ||
    email.value.trim() === "" ||
    password.value === "" ||
    workspaceName.value.trim() === ""
  ) {
    errorMessage.value = "Fill in every field to create your workspace.";
    return;
  }
  if (password.value.length < 8) {
    errorMessage.value = "Use a password of at least 8 characters.";
    return;
  }
  pending.value = true;
  try {
    await signup(name.value.trim(), email.value.trim(), password.value, workspaceName.value.trim());
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
  <section class="panel auth-card" aria-labelledby="signup-title">
    <div class="auth-brand">
      <span class="auth-brand-mark" aria-hidden="true"><Activity :size="18" /></span>
      <div class="auth-brand-copy">
        <strong>AI Workforce</strong>
        <span>Operations workspace</span>
      </div>
    </div>
    <h1 id="signup-title" class="auth-title">Create your workspace</h1>
    <p class="auth-subtitle">Set up your account and first workspace to get started.</p>

    <form class="auth-form" novalidate @submit.prevent="onSubmit">
      <div>
        <label class="field-label auth-label" for="signup-name">Name</label>
        <div class="lookup-control">
          <User :size="15" aria-hidden="true" />
          <input
            id="signup-name"
            v-model="name"
            type="text"
            name="name"
            autocomplete="name"
            :disabled="pending"
            :aria-invalid="errorMessage !== '' ? 'true' : undefined"
            placeholder="Ada Lovelace"
          />
        </div>
      </div>
      <div>
        <label class="field-label auth-label" for="signup-email">Email</label>
        <div class="lookup-control">
          <Mail :size="15" aria-hidden="true" />
          <input
            id="signup-email"
            v-model="email"
            type="email"
            name="email"
            autocomplete="email"
            inputmode="email"
            :disabled="pending"
            :aria-invalid="errorMessage !== '' ? 'true' : undefined"
            placeholder="you@example.com"
          />
        </div>
      </div>
      <div>
        <label class="field-label auth-label" for="signup-password">Password</label>
        <div class="lookup-control">
          <Lock :size="15" aria-hidden="true" />
          <input
            id="signup-password"
            v-model="password"
            type="password"
            name="password"
            autocomplete="new-password"
            :disabled="pending"
            :aria-invalid="errorMessage !== '' ? 'true' : undefined"
            :aria-describedby="errorMessage !== '' ? 'signup-error' : 'signup-password-hint'"
            placeholder="At least 8 characters"
          />
        </div>
        <p id="signup-password-hint" class="auth-hint">Use at least 8 characters.</p>
      </div>
      <div>
        <label class="field-label auth-label" for="signup-workspace">Workspace name</label>
        <div class="lookup-control">
          <Building2 :size="15" aria-hidden="true" />
          <input
            id="signup-workspace"
            v-model="workspaceName"
            type="text"
            name="workspaceName"
            autocomplete="organization"
            :disabled="pending"
            :aria-invalid="errorMessage !== '' ? 'true' : undefined"
            placeholder="Acme Inc"
          />
        </div>
      </div>

      <p v-if="errorMessage" id="signup-error" class="auth-error" role="alert">{{ errorMessage }}</p>

      <button class="button button-primary auth-submit" type="submit" :disabled="pending">
        {{ pending ? "Creating workspace…" : "Create workspace" }}
      </button>
    </form>

    <p class="auth-alt">
      Already have an account?
      <NuxtLink to="/login">Sign in.</NuxtLink>
    </p>
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
/* The global `h1 { color: var(--text) }` rule targets the element directly and
   so beats the light color inherited from `.auth-shell`; without an explicit
   color the heading renders dark-on-dark (near-invisible) on the auth surface. */
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
.auth-submit { width: 100%; margin-top: 2px; }
.auth-alt { margin: 18px 0 0; font-size: 12px; color: var(--landing-dim); }
.auth-alt a { color: var(--landing-mist); }
.auth-back {
  display: inline-block; margin-top: 10px; font-size: 12px; color: var(--landing-faint);
}
.auth-back:hover { color: var(--landing-mist); }
</style>

