from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

EXPECTED_BASELINE = "6912b8aabb64600dd9da8702c5a04c8f867f7bc2"


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Telemetry overlay expected exactly one match in {path} but found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: apply_overlay.py <Fizgig root> <overlay module>")
    root = Path(sys.argv[1]).resolve()
    module = Path(sys.argv[2]).resolve()
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if head != EXPECTED_BASELINE:
        raise RuntimeError(
            "Fizgig telemetry overlay is baseline-sensitive. "
            f"Expected {EXPECTED_BASELINE}, got {head}. Rebaseline and review the observer hooks before building."
        )

    destination = root / "src" / "fizgig" / "training" / "web_telemetry.py"
    shutil.copy2(module, destination)

    train_utils = root / "src" / "fizgig" / "training" / "train_utils.py"
    replace_once(
        train_utils,
        '        self._empty: set[int] = set()  # slots not currently holding a live loss\n',
        '        self._empty: set[int] = set()  # slots not currently holding a live loss\n'
        '        self._web_telemetry = bool(os.environ.get("FIZGIG_TELEMETRY_DIR", "").strip())\n',
    )
    replace_once(
        train_utils,
        '        self.loss_total += loss\n',
        '        self.loss_total += loss\n'
        '        if self._web_telemetry:\n'
        '            try:\n'
        '                from fizgig.training.web_telemetry import emit_metric\n'
        '                emit_metric(epoch=epoch, step=step, loss=loss, moving_average=self.moving_average)\n'
        '            except Exception:\n'
        '                pass\n',
    )

    loss_logger = root / "src" / "fizgig" / "training" / "loss_logger.py"
    replace_once(
        loss_logger,
        '            try:\n                d = os.path.join(self.output_dir, "loss_log")\n',
        '            if os.environ.get("FIZGIG_TELEMETRY_DIR", "").strip():\n'
        '                try:\n'
        '                    from fizgig.training.web_telemetry import emit_decision_snapshot\n'
        '                    emit_decision_snapshot(epoch=epoch, stats=stats, improving_count=improving_count,\n'
        '                                           plateaued=self.plateaued, pending_count=self.plateau_pending,\n'
        '                                           best_epoch_estimate=self.best_epoch_estimate,\n'
        '                                           recommended_multipliers=self._mult)\n'
        '                except Exception:\n'
        '                    pass\n'
        '            try:\n'
        '                d = os.path.join(self.output_dir, "loss_log")\n',
    )

    # Krea 2 exposes the optimizer LR, sampled timestep and asset identity at the same point as
    # its existing passive per-image observation. Capture those values for graph overlays without
    # moving or changing any training operation.
    krea_trainer = root / "src" / "fizgig" / "krea2" / "trainer.py"
    replace_once(
        krea_trainer,
        '            if loss_watch is not None:\n'
        '                loss_watch.observe(epoch=epoch + 1, step=global_step,\n'
        '                                   item_keys=batch.get("item_keys"), timestep=t_used, loss=loss.item())\n'
        '            # refresh=False so only update(1) draws the bar — otherwise set_postfix AND update each\n',
        '            if loss_watch is not None:\n'
        '                loss_watch.observe(epoch=epoch + 1, step=global_step,\n'
        '                                   item_keys=batch.get("item_keys"), timestep=t_used, loss=loss.item())\n'
        '            if os.environ.get("FIZGIG_TELEMETRY_DIR", "").strip():\n'
        '                try:\n'
        '                    from fizgig.training.web_telemetry import emit_step_context\n'
        '                    emit_step_context(epoch=epoch + 1, global_step=global_step,\n'
        '                                      lr=optimizer.param_groups[0]["lr"], timestep=t_used,\n'
        '                                      item_keys=batch.get("item_keys"), loss_multiplier=step_mult)\n'
        '                except Exception:\n'
        '                    pass\n'
        '            # refresh=False so only update(1) draws the bar — otherwise set_postfix AND update each\n',
    )
    replace_once(
        krea_trainer,
        '        logger.info(f"[adaptive_lr] epoch {epoch + 1}: loss={current_loss:.4f} lr={lr_str} "\n'
        '                    f"wnorm_Δ={wn_str} | {action} ({reason})")\n'
        '        self.prev_weight_norm = cur_wn\n',
        '        logger.info(f"[adaptive_lr] epoch {epoch + 1}: loss={current_loss:.4f} lr={lr_str} "\n'
        '                    f"wnorm_Δ={wn_str} | {action} ({reason})")\n'
        '        if os.environ.get("FIZGIG_TELEMETRY_DIR", "").strip():\n'
        '            try:\n'
        '                from fizgig.training.web_telemetry import emit_adaptive_lr\n'
        '                emit_adaptive_lr(epoch=epoch + 1, loss=current_loss, action=action, reason=reason,\n'
        '                                 before_lr=cur_lr, after_lr=new_lr, weight_growth=weight_growth)\n'
        '            except Exception:\n'
        '                pass\n'
        '        self.prev_weight_norm = cur_wn\n',
    )

    print(f"Applied passive fizgig-web telemetry overlay to {head}")


if __name__ == "__main__":
    main()
