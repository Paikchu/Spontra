/** Ancillary storage/cleanup must not hold a model stream beyond its progress deadline. */
export async function boundedModelIO<T>(work: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`model-io-timeout:${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
