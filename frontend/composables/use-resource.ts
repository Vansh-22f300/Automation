import { onMounted, ref } from 'vue';

export function useResource<T>(loader: () => Promise<T>, immediate = true) {
  const data = ref<T>();
  const error = ref<string>();
  const pending = ref(false);

  async function refresh(): Promise<void> {
    pending.value = true;
    error.value = undefined;
    try {
      data.value = await loader();
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : 'Something went wrong.';
    } finally {
      pending.value = false;
    }
  }

  if (immediate) onMounted(() => void refresh());

  return { data, error, pending, refresh };
}
