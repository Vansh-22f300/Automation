<template>
  <div class="state-panel state-loading" role="status" aria-live="polite" aria-busy="true" style="color:var(--landing-dim)">
    <span class="spinner" aria-hidden="true" style="border-color:var(--landing-border); border-top-color:var(--landing-lilac)" />
    <div>
      <h2 style="color:var(--landing-mist)">Loading</h2>
      <p style="color:var(--landing-dim)">Syncing workspace state from the API…</p>
    </div>
  </div>
</template>
