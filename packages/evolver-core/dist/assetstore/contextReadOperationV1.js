/** Own a local read from synchronous admission through its returned Promise.
 * This helper is suitable for side-effect-free local readers. An external
 * adapter must additionally stop and join its own worker before resolving
 * cancelAndSettle; forwarding an AbortSignal alone does not satisfy V1.
 */
export function beginLocalContextReadV1(signal, read) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
        abort();
    const result = Promise.resolve().then(() => {
        // Admission may be cancelled between the synchronous owner return and
        // the deferred local read. Never start I/O in that zero-budget window.
        if (controller.signal.aborted)
            throw new Error('context_read_aborted');
        return read(controller.signal);
    })
        .finally(() => signal?.removeEventListener('abort', abort));
    return { version: 1, result,
        cancelAndSettle: async () => { abort(); try {
            await result;
        }
        catch { /* caller receives the original result */ } } };
}