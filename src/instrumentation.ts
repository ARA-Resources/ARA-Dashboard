/**
 * Next.js instrumentation entry. Compiled for both Edge and Node.
 *
 * Node-only bootstrap (schedulers, filesystem, Python/Excel pipeline) lives in
 * instrumentation.node.ts. The NEXT_RUNTIME === "nodejs" branch is statically
 * analyzed so that graph is excluded from the Edge instrumentation bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import(
      "./instrumentation.node"
    );
    await registerNodeInstrumentation();
  }
}
