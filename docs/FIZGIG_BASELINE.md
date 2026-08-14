# Fizgig upstream baseline and telemetry A/B contract

`fizgig-web` does not vendor the Fizgig trainer. The RunPod image contains a separately checked-out
upstream Fizgig tree plus a deliberately tiny, observation-only telemetry overlay.

## Current baseline

- Upstream repository: `https://github.com/shootthesound/Fizgig.git`
- Pinned upstream commit: `6912b8aabb64600dd9da8702c5a04c8f867f7bc2`
- Overlay guard: `fizgig_overlay/apply_overlay.py` refuses to patch any other commit.

The image writes the actual checkout SHA to `/opt/Fizgig/.fizgig-web-built-ref`. `/api/runtime` and
each launched run expose that SHA alongside the `fizgig-web` image/VCS identity.

## Why the overlay is baseline-sensitive

The first telemetry pass adds only three observer hook points:

1. `training/train_utils.py` — after `LossRecorder` accepts the loss already used by Fizgig.
2. `krea2/trainer.py` — beside the existing per-image observation, where asset, timestep and the
   optimizer's current LR are already known.
3. `training/loss_logger.py` — after Fizgig has made its epoch-boundary loss-watch classifications.

The hooks write JSONL and swallow their own failures. They do not modify the loss, gradient,
optimizer, sampling order, caption, cache, dataset, or policy state.

Pinning the exact upstream SHA is intentional. If upstream moves, the build must stop instead of
silently applying an old textual patch to code whose surrounding training semantics may have
changed.

## Rebaseline procedure

When adopting a newer upstream Fizgig version:

1. Record the old and proposed upstream SHAs.
2. Review upstream changes to the three hook sites and to the Krea 2 cache/train CLIs.
3. Reapply the observer hooks at the semantically equivalent locations; do not broaden them into
   training behavior changes during the rebaseline.
4. Update the pinned SHA in `Dockerfile.runpod`, `build_fizgig-web.sh`, and
   `fizgig_overlay/apply_overlay.py` together.
5. Build the image. A hook whose exact expected source no longer exists must fail the build.
6. Run the A/B baseline below before accepting the new upstream SHA for intervention work.

Once intervention hooks exist, keep them in separate commits/modules from telemetry so an upstream
rebaseline can first prove observation parity before any policy-changing code is re-enabled.

## A/B baseline

A prepared web run writes:

- `Fizgig_train.toml` — exact dataset configuration used by the trainer.
- `commands.json` — exact cache/train argv generated for the run.
- `dataset_snapshot.json` — project/run asset provenance and hashes.
- `run.json` — configuration and baked software identities.

For the reference run, use the same pinned upstream commit, dataset shim, TOML, argv, model files,
seed, precision, optimizer and LR settings. Keep Fizgig's `--log_per_image_loss` enabled on both
sides so the same stock loss-watch path executes. The only intended difference is that the web run
sets `FIZGIG_TELEMETRY_DIR` and therefore writes additional observer JSONL.

Compare, in order:

1. sample/image order and sampled timesteps;
2. per-step raw loss within expected numeric tolerance;
3. moving-average loss trajectory;
4. optimizer LR trajectory, including adaptive-LR changes if enabled;
5. per-image loss-watch residuals and epoch verdicts;
6. checkpoint/sample outcomes and weight movement;
7. checkpoint hashes only when the chosen CUDA/PyTorch path is known to be bit-deterministic.

A runtime slowdown from synchronous telemetry I/O is a performance finding, not automatically a
training-parity failure. Any repeatable change in the numeric trajectory is a parity failure and
blocks intervention work.

## Observer-mode semantics

The baseline launcher currently supports Krea 2 with batch size 1. It enables Fizgig's stock
per-image loss watch for observation, but does **not** enable:

- per-image adaptive LR;
- automatic recaption;
- look-outlier warm-up;
- web `Always Train`/recaption policy enforcement;
- web-triggered retirement or exclusion.

`decision_history.jsonl` records both Fizgig's analytical verdict and the multiplier it would
recommend. The effective per-image multiplier remains `1.0` in the observer baseline. Global
adaptive LR is allowed because it is ordinary Fizgig training behavior; the actual optimizer LR is
recorded so its changes are visible on the global chart.

Do not enable trajectory-shaping controls until the A/B baseline is accepted.
