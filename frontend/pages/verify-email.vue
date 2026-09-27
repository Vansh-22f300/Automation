<script setup lang="ts">
import { Activity } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { ApiClientError } from "~/lib/api-client";

definePageMeta({ layout: "auth" });

const { isAuthenticated, syncIdentity, resendVerification } = useAuth();
const route = useRoute();

// Coarse status flag set by the BFF handoff AFTER it consumed the one-time token
// server-side — never the token itself. Anything unrecognised is treated as an
// invalid link.
type Status = "success" | "invalid" | "error";
const status = computed<Status>(() => {
  const raw = route.query.status;
  return raw === "success" || raw === "error" ? raw : "invalid";
});

const resendState = ref<"idle" | "sending" | "sent" | "error">("idle");
const resendMessage = ref("");

onMounted(() => {
  // A freshly verified address changes the authenticated identity; if we hold a
  // live session, re-sync so the in-app "verify your email" prompt clears.
  if (status.value === "success" && isAuthenticated.value) {
    void syncIdentity();
  }
});

async function onResend(): Promise<void> {
  if (resendState.value === "sending") return;
  resendState.value = "sending";
  resendMessage.value = "";
  try {
    await resendVerification();
    resendState.value = "sent";
    resendMessage.value =
      "If your address still needs verifying, a new link is on its way.";
  } catch (caught) {
    resendState.value = "error";
    resendMessage.value =
      caught instanceof ApiClientError && caught.status === 429
        ? "Please wait a moment before requesting another email."
        : "We couldn't send a new link right now. Please try again shortly.";
  }
}
</script>
<!-- @@BODY@@ -->

<template>
  <section class="panel auth-card" aria-labelledby="verify-title">
    <div class="auth-brand">
      <span class="auth-brand-mark" aria-hidden="true"><Activity :size="18" /></span>
      <div class="auth-brand-copy">
        <strong>AI Workforce</strong>
        <span>Operations workspace</span>
      </div>
    </div>

    <template v-if="status === 'success'">
      <h1 id="verify-title" class="auth-title">Email verified</h1>
      <p class="auth-note" role="status">
        Your email address is confirmed — your workspace is fully set up.
      </p>
      <NuxtLink
        :to="isAuthenticated ? '/workflows' : '/login'"
        class="button button-primary auth-submit"
      >
        {{ isAuthenticated ? "Go to workspace" : "Continue to sign in" }}
      </NuxtLink>
    </template>

    <template v-else-if="status === 'error'">
      <h1 id="verify-title" class="auth-title">Verification unavailable</h1>
      <p class="auth-subtitle">
        We couldn't verify your email right now. The link is still valid — please
        try opening it again in a moment.
      </p>
      <NuxtLink to="/login" class="button button-primary auth-submit">Back to sign in</NuxtLink>
    </template>

    <template v-else>
      <h1 id="verify-title" class="auth-title">Link expired</h1>
      <p class="auth-subtitle">
        This verification link is invalid or has already been used.
      </p>
      <template v-if="isAuthenticated">
        <button
          class="button button-primary auth-submit"
          type="button"
          :disabled="resendState === 'sending'"
          @click="onResend"
        >
          {{ resendState === "sending" ? "Sending…" : "Resend verification email" }}
        </button>
        <p
          v-if="resendMessage"
          class="auth-note"
          :class="{ 'auth-note-warn': resendState === 'error' }"
          role="status"
        >
          {{ resendMessage }}
        </p>
      </template>
      <NuxtLink v-else to="/login" class="button button-primary auth-submit">
        Sign in to resend
      </NuxtLink>
    </template>

    <NuxtLink to="/" class="auth-back">&larr; Back to overview</NuxtLink>
  </section>
</template>
<!-- @@STYLE@@ -->

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
.auth-note {
  margin: 0 0 14px; font-size: 13px; color: var(--landing-mist); line-height: 1.5;
  padding: 12px 14px; border-radius: 10px;
  background: rgba(139,245,201,0.08); border: 1px solid rgba(139,245,201,0.20);
}
.auth-note-warn {
  color: var(--landing-danger);
  background: rgba(255,107,107,0.10); border-color: rgba(255,107,107,0.22);
}
.auth-submit { width: 100%; margin-top: 2px; text-align: center; }
.auth-back {
  display: inline-block; margin-top: 10px; font-size: 12px; color: var(--landing-faint);
}
.auth-back:hover { color: var(--landing-mist); }
</style>
