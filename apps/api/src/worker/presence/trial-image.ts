/**
 * What the Engine says about the trial image, asked through docker-guard,
 * which lets the worker inspect the trial image and no other. The isolation
 * report records the image id, so the System page names the exact image the
 * self-test proved rather than only its tag: the guard pins every trial
 * create to this id as well.
 *
 * EngineClient (sandbox/engine-client.ts) has no image call yet, so this is a
 * single request of its own over the same socket and API version.
 */
import http from 'node:http';
import { z } from 'zod';

const API_VERSION = 'v1.45';

/** The label docker/trial.Dockerfile sets to the Hermes git sha. */
export const HERMES_REVISION_LABEL = 'org.hermes-evals.hermes-revision';

const ImageInspectSchema = z.object({
  Id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullish() }).nullish(),
});

export interface TrialImageFacts {
  /** The image id, `sha256:<hex>`. */
  id: string;
  /** The Hermes revision the image's label names, or null when it has no such label. */
  revision: string | null;
}

/** Inspects `image` through the guard socket. Throws when the guard refuses or cannot answer. */
export function inspectTrialImage(
  socketPath: string,
  image: string,
  timeoutMs = 5_000,
): Promise<TrialImageFacts> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: 'GET',
      path: `/${API_VERSION}/images/${encodeURIComponent(image)}/json`,
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`inspect ${image} timed out`)));
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 0) !== 200) {
          reject(new Error(`inspect ${image}: ${res.statusCode} ${text.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = ImageInspectSchema.parse(JSON.parse(text));
          resolve({
            id: parsed.Id,
            revision: parsed.Config?.Labels?.[HERMES_REVISION_LABEL] ?? null,
          });
        } catch (err) {
          reject(new Error(`inspect ${image}: unreadable answer (${(err as Error).message})`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
