/**
 * ONNX Runtime Web, loaded from the copy vendored in app/vendor/ort/.
 *
 * Nothing here is fetched from a CDN at run time: the app must work with the network off,
 * because the models are on disk and the whole design is local. app/fetch-deps.sh is what
 * a fresh clone runs once to put the runtime and the weights in place.
 *
 * WebGPU is used when the browser has it (a third party measured this exact depth model
 * at ~20 fps that way; see ARCHITECTURE.md) and WASM otherwise. Either is fine: the
 * neural nets run ONCE, at scene setup. A 2 fps depth model is irrelevant when it runs
 * once. That sentence is the whole reason this project fits in a browser.
 */
let ortPromise = null;

export async function getOrt() {
  if (!ortPromise) {
    ortPromise = (async () => {
      const url = new URL('../vendor/ort/ort.webgpu.bundle.min.mjs', import.meta.url);
      const ort = await import(url.href);
      ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
      ort.env.wasm.numThreads = (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)
        ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      ort.env.logLevel = 'error';
      // Run the WASM execution provider in a worker. Without this, a machine that falls back
      // off WebGPU runs SlimSAM's 1024x1024 encoder on the main thread and the tab stops
      // answering the compositor; with it, the page stays interactive and the progress bar
      // keeps moving. WebGPU still does some main-thread work, which is why the encode is
      // also deferred to the first tap rather than run at scene setup.
      ort.env.wasm.proxy = true;
      return ort;
    })();
  }
  return ortPromise;
}

export function modelUrl(name) {
  return new URL(`../../models/${name}`, import.meta.url).href;
}

/** Try WebGPU, fall back to WASM, and report which one actually happened. */
export async function createSession(name, onProgress) {
  const ort = await getOrt();
  const url = modelUrl(name);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`cannot load ${name} (HTTP ${resp.status}). ` +
      `Run app/fetch-deps.sh -- the weights are gitignored, they are not in the clone.`);
  }
  const total = Number(resp.headers.get('content-length') || 0);
  let buf;
  if (resp.body && onProgress && total) {
    const reader = resp.body.getReader();
    const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress(got / total);
    }
    buf = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
  } else {
    buf = new Uint8Array(await resp.arrayBuffer());
  }
  for (const ep of ['webgpu', 'wasm']) {
    try {
      const s = await ort.InferenceSession.create(buf, { executionProviders: [ep] });
      return { session: s, ep, ort, bytes: buf.length };
    } catch (e) {
      if (ep === 'wasm') throw e;
    }
  }
}
