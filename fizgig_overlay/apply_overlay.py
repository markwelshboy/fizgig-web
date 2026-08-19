from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

EXPECTED_BASELINE = "d8e881c339cf25cc03777e65a41e7005380cc8b0"


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
    policy_module = module.with_name("web_policy.py")
    if not policy_module.is_file():
        raise RuntimeError(f"Missing web policy overlay module: {policy_module}")
    shutil.copy2(policy_module, root / "src" / "fizgig" / "training" / "web_policy.py")

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
        '        self.dataset_dir = dataset_dir\n'
        '        self.caption_ext = caption_ext\n',
        '        self.dataset_dir = dataset_dir\n'
        '        self.caption_ext = caption_ext\n'
        '        try:\n'
        '            from fizgig.training.web_policy import load_asset_policy\n'
        '            self._web_asset_policy = load_asset_policy(dataset_dir)\n'
        '        except Exception:\n'
        '            self._web_asset_policy = {}\n',
    )
    replace_once(
        loss_logger,
        '            else:\n'
        '                self._excluded.add(str(key))\n'
        '                self._incorrigible.add(str(key))\n',
        '            else:\n'
        '                if self.web_training_policy(key) != "always_train":\n'
        '                    self._excluded.add(str(key))\n'
        '                    self._incorrigible.add(str(key))\n',
    )
    replace_once(
        loss_logger,
        '    def set_warmup_keys(self, keys, *, start: float = 0.4, ramp_epochs: int = 4) -> None:\n',
        '    def web_asset_policy(self, item_keys) -> dict:\n'
        '        """Run-local fizgig-web policy for this trainer-visible asset key."""\n'
        '        try:\n'
        '            from fizgig.training.web_policy import policy_for\n'
        '            return policy_for(getattr(self, "_web_asset_policy", {}), self._key_of(item_keys))\n'
        '        except Exception:\n'
        '            return {"training_policy": "automatic", "auto_recaption_policy": "automatic"}\n'
        '\n'
        '    def web_training_policy(self, item_keys) -> str:\n'
        '        return str(self.web_asset_policy(item_keys).get("training_policy") or "automatic")\n'
        '\n'
        '    def web_allows_auto_recaption(self, item_keys) -> bool:\n'
        '        return str(self.web_asset_policy(item_keys).get("auto_recaption_policy") or "automatic") == "automatic"\n'
        '\n'
        '    def set_warmup_keys(self, keys, *, start: float = 0.4, ramp_epochs: int = 4) -> None:\n',
    )
    replace_once(
        loss_logger,
        '        if self._batched:\n'
        '            return 1.0\n'
        '        key = self._key_of(item_keys)\n'
        '        wm = self._warmup_mult(key)\n',
        '        if self._batched:\n'
        '            return 1.0\n'
        '        key = self._key_of(item_keys)\n'
        '        if self.web_training_policy(key) == "always_train":\n'
        '            return 1.0\n'
        '        wm = self._warmup_mult(key)\n',
    )
    replace_once(
        loss_logger,
        '        if self._batched:\n'
        '            return False\n'
        '        return self._key_of(item_keys) in self._excluded\n',
        '        if self._batched:\n'
        '            return False\n'
        '        key = self._key_of(item_keys)\n'
        '        if self.web_training_policy(key) == "always_train":\n'
        '            return False\n'
        '        return key in self._excluded\n',
    )
    replace_once(
        loss_logger,
        '                elif key in self._confirmed_stuck and key in self._incorrigible:\n',
        '                elif (key in self._confirmed_stuck and key in self._incorrigible\n'
        '                      and self.web_training_policy(key) != "always_train"):\n',
    )
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
        '                    emit_step_context(epoch=epoch + 1, step_in_epoch=i, global_step=global_step,\n'
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

    # The frozen web asset policy is keyed to trainer-visible filenames. Automatic is deliberately
    # the no-op/default: with no sidecar, or with Auto/Auto, upstream Fizgig behavior is unchanged.
    # Hold/Never suppress only the automatic candidate path; manual caption_updates.json still wins.
    replace_once(
        krea_trainer,
        '            if k in updates or attempts >= 2:\n'
        '                continue\n',
        '            if k in updates or attempts >= 2:\n'
        '                continue\n'
        '            if loss_watch is not None and not loss_watch.web_allows_auto_recaption(k):\n'
        '                continue\n',
    )

    # Preview-only web extension: Fizgig standalone intentionally exposes one --sample_seed and
    # renders prompt i with seed+i. The web project model keeps explicit per-probe seeds. Read
    # those frozen configured_seed values from run.json only when the web telemetry environment
    # is present, so standalone Fizgig remains byte-for-byte on its native seed+i behavior.
    replace_once(
        krea_trainer,
        '    paths = []\n'
        '    last_prompt = None\n'
        '    # Negative prompt rides through the CFG path (untxt) — only when CFG is actually on.\n',
        '    paths = []\n'
        '    last_prompt = None\n'
        '    _web_sample_seeds = None\n'
        '    if os.environ.get("FIZGIG_TELEMETRY_DIR", "").strip():\n'
        '        try:\n'
        '            _run_json = os.path.join(os.path.dirname(out_dir), "run.json")\n'
        '            with open(_run_json, encoding="utf-8") as _f:\n'
        '                _run = json.load(_f)\n'
        '            _defs = (((_run.get("config") or {}).get("sampling") or {}).get("samples") or [])\n'
        '            _seeds = [int(_s.get("configured_seed", _s.get("seed"))) for _s in _defs\n'
        '                      if isinstance(_s, dict) and _s.get("configured_seed", _s.get("seed")) is not None]\n'
        '            if len(_seeds) == len(encoded_prompts):\n'
        '                _web_sample_seeds = _seeds\n'
        '        except Exception:\n'
        '            _web_sample_seeds = None\n'
        '    # Negative prompt rides through the CFG path (untxt) — only when CFG is actually on.\n',
    )
    replace_once(
        krea_trainer,
        '    for i, (txt, txtmask) in enumerate(encoded_prompts):\n'
        '        with torch.no_grad():\n',
        '    for i, (txt, txtmask) in enumerate(encoded_prompts):\n'
        '        _web_seed = _web_sample_seeds[i] if _web_sample_seeds is not None else seed + i\n'
        '        with torch.no_grad():\n',
    )
    replace_once(
        krea_trainer,
        '                                   steps=steps, cfg_scale=cfg_scale, mu=1.15, seed=seed + i)\n',
        '                                   steps=steps, cfg_scale=cfg_scale, mu=1.15, seed=_web_seed)\n',
    )
    replace_once(
        krea_trainer,
        '        p = os.path.join(out_dir, f"{output_name}_e{epoch:06d}_{i:02d}_{ts}_{seed + i}.png")\n',
        '        p = os.path.join(out_dir, f"{output_name}_e{epoch:06d}_{i:02d}_{ts}_{_web_seed}.png")\n',
    )

    print(f"Applied fizgig-web telemetry + preview + intervention policy overlay to {head}")


if __name__ == "__main__":
    main()
