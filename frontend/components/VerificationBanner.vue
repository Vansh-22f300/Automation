<script setup lang="ts">
import { MailWarning, X } from "@lucide/vue";
import { onMounted, ref } from "vue";
import { ApiClientError } from "~/lib/api-client";

/**
 * In-app prompt for signed-in users whose email is not yet verified.
 *
 * Verification is intentionally NOT a hard gate — access to the workspace is
 * preserved (§4/§16). This is a gentle, dismissible nudge with a one-click
 * resend. It reveals nothing sensitive: no token, no other account's state.
 */
const { user, isAuthenticated, needsVerification, syncIdentity, resendVerification } = useAuth();

const dismissed = ref(false);
const resendState = ref<"idle" | "sending" | "sent" | "error">("idle");
const resendMessage = ref("");

onMounted(() => {
  // Right after an in-SPA login/signup the verification state is still unknown
  // (the login response omits it). Resolve it once so the prompt reflects the
  // real state instead of staying hidden until the next hard reload.
  if (isAuthenticated.value && user.value?.emailVerifiedAt === undefined) {
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
    resendMessage.value = "Verification email sent — check your inbox.";
  } catch (caught) {
    resendState.value = "error";
    resendMessage.value =
      caught instanceof ApiClientError && caught.status === 429
        ? "Please wait a moment before requesting another email."
        : "Couldn't send right now. Please try again shortly.";
  }
}
</script>

<template>
  <div v-if="needsVerification && !dismissed" class="verify-banner" role="status">
    <span class="verify-icon" aria-hidden="true"><MailWarning :size="16" /></span>
    <div class="verify-copy">
      <strong>Verify your email</strong>
      <span>
        We sent a verification link to
        <span class="verify-email">{{ user?.email }}</span>. Verify to secure your account.
      </span>
      <span v-if="resendMessage" class="verify-feedback" :class="{ 'is-error': resendState === 'error' }">
        {{ resendMessage }}
      </span>
    </div>
    <div class="verify-actions">
      <button
        v-if="resendState !== 'sent'"
        class="button verify-resend"
        type="button"
        :disabled="resendState === 'sending'"
        @click="onResend"
      >
        {{ resendState === "sending" ? "Sending…" : "Resend email" }}
      </button>
      <button class="verify-dismiss" type="button" aria-label="Dismiss" @click="dismissed = true">
        <X :size="15" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.verify-banner {
  display: flex; align-items: flex-start; gap: 12px;
  margin: 0 0 20px; padding: 12px 14px; border-radius: 12px;
  background: rgba(255,196,110,0.08); border: 1px solid rgba(255,196,110,0.22);
  color: var(--landing-mist);
}
.verify-icon {
  display: grid; place-items: center; flex: 0 0 auto; margin-top: 1px;
  color: #ffc46e;
}
.verify-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 12px; }
.verify-copy strong { font-size: 13px; letter-spacing: -0.01em; }
.verify-copy span { color: var(--landing-dim); }
.verify-email { color: var(--landing-mist); word-break: break-all; }
.verify-feedback { color: var(--landing-mint) !important; margin-top: 2px; }
.verify-feedback.is-error { color: var(--landing-danger) !important; }
.verify-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; flex: 0 0 auto; }
.verify-resend {
  border-color: rgba(255,196,110,0.28); background: rgba(255,196,110,0.10);
  color: var(--landing-mist); font-size: 12px; padding: 6px 12px; white-space: nowrap;
}
.verify-resend:hover:not(:disabled) { background: rgba(255,196,110,0.18); }
.verify-dismiss {
  display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px;
  border: 1px solid transparent; background: transparent; color: var(--landing-faint); cursor: pointer;
}
.verify-dismiss:hover { color: var(--landing-mist); background: rgba(255,255,255,0.06); }
@media (max-width: 560px) {
  .verify-banner { flex-wrap: wrap; }
  .verify-actions { margin-left: 0; width: 100%; }
  .verify-resend { flex: 1 1 auto; }
}
</style>
