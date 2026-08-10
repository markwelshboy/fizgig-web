from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .projects import project_store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(value, ensure_ascii=False) + "\n")
        f.flush()


DEFAULT_GLOBAL_TRANSFORM: dict[str, Any] = {
    "aspect_ratio": "16:9", "crop_mode": "fill", "crop_x": 0.5, "crop_y": 0.5,
    "exposure": 0.0, "brightness": 0.0, "contrast": 0.0, "gamma": 1.0,
}
DEFAULT_TRAINING_RESOLUTION: dict[str, Any] = {
    "max_megapixels": 1.0, "enable_bucket": True, "bucket_no_upscale": True, "dimension_step": 16,
}


def _image_dimensions(path: Path) -> tuple[int, int]:
    try:
        from PIL import Image
    except Exception as exc:
        raise RuntimeError("Image inspection requires Pillow") from exc
    with Image.open(path) as image:
        return image.size


def _parse_aspect(value: str) -> float:
    try:
        left, right = str(value).split(":", 1); ratio = float(left) / float(right)
        return ratio if ratio > 0 else 1.0
    except Exception:
        return 1.0


def _effective_transform(manifest: dict[str, Any], asset: dict[str, Any]) -> dict[str, Any]:
    transform = {**DEFAULT_GLOBAL_TRANSFORM, **manifest.get("global_transform", {}), **asset.get("transform_override", {})}
    if "aspect_ratio" not in asset.get("transform_override", {}):
        for operation in reversed(asset.get("operations", [])):
            if operation.get("type") == "manual_crop" and operation.get("aspect_ratio"):
                transform["aspect_ratio"] = operation["aspect_ratio"]; break
    return transform


def _crop_box(width: int, height: int, transform: dict[str, Any]) -> tuple[int, int, int, int]:
    if transform.get("crop_mode", "fill") != "fill": return 0, 0, width, height
    target = _parse_aspect(str(transform.get("aspect_ratio", "1:1"))); source = width / max(1, height)
    pos_x = max(0.0, min(1.0, float(transform.get("crop_x", 0.5)))); pos_y = max(0.0, min(1.0, float(transform.get("crop_y", 0.5))))
    if abs(source - target) < 1e-6: return 0, 0, width, height
    if source > target:
        crop_h = height; crop_w = max(1, min(width, round(height * target))); left = round((width - crop_w) * pos_x)
        return left, 0, left + crop_w, crop_h
    crop_w = width; crop_h = max(1, min(height, round(width / target))); top = round((height - crop_h) * pos_y)
    return 0, top, crop_w, top + crop_h


def _bucket_for(width: int, height: int, policy: dict[str, Any]) -> dict[str, Any]:
    step = max(8, int(policy.get("dimension_step", 16))); max_pixels = max(0.01, float(policy.get("max_megapixels", 1.0))) * 1_000_000
    source_pixels = max(1, width * height); requested_scale = math.sqrt(max_pixels / source_pixels)
    scale = min(1.0, requested_scale) if bool(policy.get("bucket_no_upscale", True)) else requested_scale
    target_w = max(step, int(width * scale) // step * step); target_h = max(step, int(height * scale) // step * step); target_pixels = target_w * target_h
    linear_scale = min(target_w / max(1, width), target_h / max(1, height))
    return {"source_width": width, "source_height": height, "source_megapixels": round(source_pixels / 1_000_000, 3), "bucket_width": target_w, "bucket_height": target_h, "bucket_megapixels": round(target_pixels / 1_000_000, 3), "linear_scale": round(linear_scale, 3), "direction": "downscale" if linear_scale < 0.995 else ("upscale" if linear_scale > 1.005 else "native"), "low_detail": source_pixels < max_pixels * 0.5}


def _resolution_analysis(path: Path, transform: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    file_width, file_height = _image_dimensions(path); box = _crop_box(file_width, file_height, transform)
    crop_width = max(1, box[2] - box[0]); crop_height = max(1, box[3] - box[1]); bucket = _bucket_for(crop_width, crop_height, policy)
    return {"file_width": file_width, "file_height": file_height, "file_megapixels": round(file_width * file_height / 1_000_000, 3), "crop_box": list(box), "crop_width": crop_width, "crop_height": crop_height, "crop_megapixels": round(crop_width * crop_height / 1_000_000, 3), "effective_transform": transform, **bucket}


def _apply_tonal_adjustments(image, transform: dict[str, Any]):
    from PIL import ImageEnhance
    exposure = float(transform.get("exposure", 0.0)); brightness = float(transform.get("brightness", 0.0)); contrast = float(transform.get("contrast", 0.0)); gamma = max(0.05, float(transform.get("gamma", 1.0)))
    exposure_factor = 2.0 ** max(-8.0, min(8.0, exposure)); brightness_factor = max(0.0, 1.0 + brightness); contrast_factor = max(0.0, 1.0 + contrast)
    if abs(exposure_factor - 1.0) > 1e-6: image = ImageEnhance.Brightness(image).enhance(exposure_factor)
    if abs(brightness_factor - 1.0) > 1e-6: image = ImageEnhance.Brightness(image).enhance(brightness_factor)
    if abs(contrast_factor - 1.0) > 1e-6: image = ImageEnhance.Contrast(image).enhance(contrast_factor)
    if abs(gamma - 1.0) > 1e-6:
        inv_gamma = 1.0 / gamma; lut = [min(255, max(0, round(((i / 255.0) ** inv_gamma) * 255.0))) for i in range(256)]; image = image.point(lut * len(image.getbands()))
    return image


def _materialize_transform(src: Path, dst: Path, transform: dict[str, Any]) -> dict[str, Any]:
    try: from PIL import Image
    except Exception as exc: raise RuntimeError("Image transform materialization requires Pillow") from exc
    with Image.open(src) as opened:
        image = opened.convert("RGB"); file_width, file_height = image.size; box = _crop_box(file_width, file_height, transform); image = _apply_tonal_adjustments(image.crop(box), transform)
        dst.parent.mkdir(parents=True, exist_ok=True); suffix = dst.suffix.lower()
        if suffix in {".jpg", ".jpeg"}: image.save(dst, quality=95, subsampling=0)
        elif suffix == ".webp": image.save(dst, quality=95)
        else: image.save(dst)
        return {"source_file_size": [file_width, file_height], "crop_box": list(box), "materialized_size": [image.width, image.height], "transform": transform}


def _face_crop_box(image_size: tuple[int, int], bbox: tuple[int, int, int, int], padding_percent: float, aspect_ratio: str) -> tuple[int, int, int, int]:
    img_w, img_h = image_size; x1, y1, x2, y2 = bbox; face_w = max(1, x2 - x1); face_h = max(1, y2 - y1)
    pad_x = face_w * max(0.0, padding_percent) / 100.0; pad_y = face_h * max(0.0, padding_percent) / 100.0
    cx = (x1 + x2) / 2.0; cy = (y1 + y2) / 2.0; crop_w = face_w + 2 * pad_x; crop_h = face_h + 2 * pad_y; target = _parse_aspect(aspect_ratio)
    if crop_w / max(1.0, crop_h) < target: crop_w = crop_h * target
    else: crop_h = crop_w / target
    crop_w = min(float(img_w), crop_w); crop_h = min(float(img_h), crop_h)
    left = max(0.0, min(img_w - crop_w, cx - crop_w / 2)); top = max(0.0, min(img_h - crop_h, cy - crop_h / 2))
    return round(left), round(top), round(left + crop_w), round(top + crop_h)


def _face_detector():
    try:
        from insightface.app import FaceAnalysis
        import cv2  # noqa: F401
    except ImportError as exc:
        raise RuntimeError("Automatic face derivatives require insightface, opencv-python-headless and onnxruntime. Install the Fizgig face-detection dependencies in the runtime.") from exc
    app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection"], providers=["CPUExecutionProvider"]); app.prepare(ctx_id=-1)
    return app


class ImagePrepStore:
    def _load(self, project_id: str, revision_id: str) -> tuple[Path, dict[str, Any]]:
        project_dir = project_store.project_dir(project_id); path = (project_dir / "datasets" / revision_id / "manifest.json").resolve()
        if project_dir not in path.parents or not path.is_file(): raise FileNotFoundError(f"Unknown dataset revision: {revision_id}")
        manifest = json.loads(path.read_text(encoding="utf-8")); changed = False
        if "global_transform" not in manifest: manifest["global_transform"] = dict(DEFAULT_GLOBAL_TRANSFORM); changed = True
        if "training_resolution" not in manifest: manifest["training_resolution"] = dict(DEFAULT_TRAINING_RESOLUTION); changed = True
        for asset in manifest.get("assets", []):
            if "included" not in asset: asset["included"] = True; changed = True
            if "asset_kind" not in asset: asset["asset_kind"] = "source"; changed = True
            if "operations" not in asset: asset["operations"] = []; changed = True
            if "transform_override" not in asset: asset["transform_override"] = {}; changed = True
        if changed: _write_json(path, manifest)
        return path, manifest

    def state(self, project_id: str, revision_id: str) -> dict[str, Any]:
        _, manifest = self._load(project_id, revision_id); assets = manifest.get("assets", []); included = [a for a in assets if a.get("included", True)]; derivatives = [a for a in assets if a.get("asset_kind") == "derived"]
        files_dir = Path(manifest["files_path"]).resolve(); policy = manifest.get("training_resolution", DEFAULT_TRAINING_RESOLUTION); resolution_assets = []
        for asset in included:
            path = (files_dir / str(asset.get("filename", ""))).resolve()
            if path.parent == files_dir and path.is_file(): resolution_assets.append({"filename": asset.get("filename"), **_resolution_analysis(path, _effective_transform(manifest, asset), policy)})
        return {"revision": revision_id, "model_family": manifest.get("model_family", "generic"), "incoming_count": len(assets), "included_count": len(included), "excluded_count": len(assets)-len(included), "derivative_count": len(derivatives), "global_transform": manifest.get("global_transform", DEFAULT_GLOBAL_TRANSFORM), "training_resolution": policy, "resolution_assets": resolution_assets, "assets": assets}

    def set_training_resolution(self, project_id: str, revision_id: str, policy: dict[str, Any]) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id); merged = {**DEFAULT_TRAINING_RESOLUTION, **manifest.get("training_resolution", {}), **policy}
        merged["max_megapixels"] = max(0.05, min(8.0, float(merged["max_megapixels"]))); merged["enable_bucket"] = bool(merged.get("enable_bucket", True)); merged["bucket_no_upscale"] = bool(merged.get("bucket_no_upscale", True)); merged["dimension_step"] = max(8, int(merged.get("dimension_step",16)))
        manifest["training_resolution"] = merged; _write_json(manifest_path, manifest); _append_jsonl(project_store.project_dir(project_id)/"events.jsonl", {"time":_now(),"type":"training_resolution_changed","revision":revision_id,"policy":merged}); return self.state(project_id, revision_id)

    def set_inclusion(self, project_id: str, revision_id: str, filenames: list[str], included: bool) -> dict[str, Any]:
        manifest_path, manifest = self._load(project_id, revision_id); wanted=set(filenames); found=[]
        for asset in manifest.get("assets",[]):
            if asset.get("filename") in wanted: asset["included"]=bool(included); found.append(str(asset["filename"]))
        missing=sorted(wanted-set(found))
        if missing: raise FileNotFoundError("Images not found in revision: "+", ".join(missing))
        _write_json(manifest_path,manifest); _append_jsonl(project_store.project_dir(project_id)/"events.jsonl",{"time":_now(),"type":"image_inclusion_changed","revision":revision_id,"included":bool(included),"filenames":sorted(found),"count":len(found)}); return self.state(project_id,revision_id)

    def set_all_inclusion(self, project_id: str, revision_id: str, included: bool) -> dict[str, Any]:
        _, manifest=self._load(project_id,revision_id); return self.set_inclusion(project_id,revision_id,[str(a.get("filename")) for a in manifest.get("assets",[]) if a.get("filename")],included)

    def set_global_transform(self, project_id: str, revision_id: str, transform: dict[str, Any]) -> dict[str, Any]:
        manifest_path,manifest=self._load(project_id,revision_id); merged={**DEFAULT_GLOBAL_TRANSFORM,**manifest.get("global_transform",{}),**transform}; manifest["global_transform"]=merged; _write_json(manifest_path,manifest); _append_jsonl(project_store.project_dir(project_id)/"events.jsonl",{"time":_now(),"type":"global_image_transform_changed","revision":revision_id,"transform":merged}); return self.state(project_id,revision_id)

    def set_asset_transform(self, project_id: str, revision_id: str, filename: str, override: dict[str, Any]) -> dict[str, Any]:
        manifest_path,manifest=self._load(project_id,revision_id); asset=next((a for a in manifest.get("assets",[]) if a.get("filename")==filename),None)
        if asset is None: raise FileNotFoundError(f"Image not found in revision: {filename}")
        asset["transform_override"]=override; _write_json(manifest_path,manifest); _append_jsonl(project_store.project_dir(project_id)/"events.jsonl",{"time":_now(),"type":"image_transform_override_changed","revision":revision_id,"filename":filename,"override":override}); return self.state(project_id,revision_id)

    def _create_crop_asset(self, project_id: str, revision_id: str, manifest_path: Path, manifest: dict[str, Any], parent: dict[str, Any], source: Path, box: tuple[int,int,int,int], aspect_ratio: str, origin: str, operation: dict[str, Any]) -> dict[str, Any]:
        from PIL import Image
        files_dir=Path(manifest["files_path"]).resolve(); suffix=aspect_ratio.replace(":","x"); index=1
        while True:
            output_name=f"{source.stem}_{origin}_{suffix}_{index:02d}.png"; output=files_dir/output_name
            if not output.exists(): break
            index+=1
        with Image.open(source) as image: image.convert("RGB").crop(box).save(output,format="PNG")
        asset={"id":uuid.uuid4().hex[:16],"filename":output.name,"image_sha256":_sha256(output),"caption":"","caption_sha256":hashlib.sha256(b"").hexdigest(),"origin":origin,"parent_asset_id":parent.get("id"),"parent_filename":source.name,"asset_kind":"derived","included":True,"transform_override":{"aspect_ratio":aspect_ratio},"operations":[operation]}
        manifest.setdefault("assets",[]).append(asset); _write_json(manifest_path,manifest); return asset

    def create_manual_crop(self, project_id: str, revision_id: str, filename: str, crop: dict[str,float], aspect_ratio: str) -> dict[str,Any]:
        manifest_path,manifest=self._load(project_id,revision_id); parent=next((a for a in manifest.get("assets",[]) if a.get("filename")==filename),None)
        if parent is None: raise FileNotFoundError(f"Image not found in revision: {filename}")
        files_dir=Path(manifest["files_path"]).resolve(); source=(files_dir/filename).resolve()
        if source.parent!=files_dir or not source.is_file(): raise FileNotFoundError(f"Working image not found: {filename}")
        width,height=_image_dimensions(source); x=max(0.0,min(1.0,float(crop.get("x",0.0)))); y=max(0.0,min(1.0,float(crop.get("y",0.0)))); w=max(0.01,min(1.0-x,float(crop.get("width",1.0)))); h=max(0.01,min(1.0-y,float(crop.get("height",1.0)))); box=(round(x*width),round(y*height),round((x+w)*width),round((y+h)*height))
        operation={"type":"manual_crop","aspect_ratio":aspect_ratio,"normalized_crop":{"x":x,"y":y,"width":w,"height":h},"pixel_box":list(box),"created_at":_now()}; asset=self._create_crop_asset(project_id,revision_id,manifest_path,manifest,parent,source,box,aspect_ratio,"manual",operation)
        _append_jsonl(project_store.project_dir(project_id)/"events.jsonl",{"time":_now(),"type":"image_derived","revision":revision_id,"method":"manual_crop","parent":filename,"filename":asset["filename"],"aspect_ratio":aspect_ratio,"crop":operation}); return {"asset":asset,"state":self.state(project_id,revision_id)}

    def propose_face_crops(self, project_id: str, revision_id: str, filenames: list[str], aspect_ratio: str="1:1", padding_percent: float=60.0) -> dict[str,Any]:
        _,manifest=self._load(project_id,revision_id); files_dir=Path(manifest["files_path"]).resolve(); detector=_face_detector(); proposals=[]
        try:
            import cv2
        except ImportError as exc: raise RuntimeError("Automatic face derivatives require OpenCV") from exc
        for filename in filenames:
            asset=next((a for a in manifest.get("assets",[]) if a.get("filename")==filename and a.get("included",True)),None)
            if asset is None: continue
            source=(files_dir/filename).resolve()
            if source.parent!=files_dir or not source.is_file(): continue
            from PIL import Image
            import numpy as np
            with Image.open(source) as pil:
                rgb=pil.convert("RGB"); arr=cv2.cvtColor(np.array(rgb),cv2.COLOR_RGB2BGR); faces=detector.get(arr); size=rgb.size
            for index,face in enumerate(sorted(faces,key=lambda f:float(getattr(f,"det_score",0.0)),reverse=True)):
                raw=tuple(int(v) for v in face.bbox); box=_face_crop_box(size,raw,padding_percent,aspect_ratio); x1,y1,x2,y2=box
                proposals.append({"id":f"{asset.get('id',filename)}:{index}:{aspect_ratio}:{padding_percent}","filename":filename,"asset_id":asset.get("id"),"face_index":index,"score":round(float(getattr(face,"det_score",0.0)),4),"face_bbox":list(raw),"crop_box":list(box),"normalized_crop":{"x":x1/size[0],"y":y1/size[1],"width":(x2-x1)/size[0],"height":(y2-y1)/size[1]},"aspect_ratio":aspect_ratio,"padding_percent":padding_percent,"source_width":size[0],"source_height":size[1]})
        _append_jsonl(project_store.project_dir(project_id)/"events.jsonl",{"time":_now(),"type":"face_crop_proposals_generated","revision":revision_id,"filenames":filenames,"aspect_ratio":aspect_ratio,"padding_percent":padding_percent,"proposal_count":len(proposals)})
        return {"proposals":proposals}

    def accept_face_crops(self, project_id: str, revision_id: str, proposals: list[dict[str,Any]]) -> dict[str,Any]:
        manifest_path,manifest=self._load(project_id,revision_id); files_dir=Path(manifest["files_path"]).resolve(); created=[]
        for proposal in proposals:
            filename=str(proposal.get("filename","")); parent=next((a for a in manifest.get("assets",[]) if a.get("filename")==filename),None)
            if parent is None: continue
            source=(files_dir/filename).resolve(); box=tuple(int(v) for v in proposal.get("crop_box",[]))
            if source.parent!=files_dir or not source.is_file() or len(box)!=4: continue
            width,height=_image_dimensions(source); x1=max(0,min(width-1,box[0])); y1=max(0,min(height-1,box[1])); x2=max(x1+1,min(width,box[2])); y2=max(y1+1,min(height,box[3])); aspect=str(proposal.get("aspect_ratio","1:1"))
            operation={"type":"face_crop","detector":"InsightFace buffalo_l","face_index":proposal.get("face_index"),"detection_score":proposal.get("score"),"face_bbox":proposal.get("face_bbox"),"padding_percent":proposal.get("padding_percent"),"aspect_ratio":aspect,"pixel_box":[x1,y1,x2,y2],"created_at":_now()}
            asset=self._create_crop_asset(project_id,revision_id,manifest_path,manifest,parent,source,(x1,y1,x2,y2),aspect,"face",operation); created.append(asset)
        _append_jsonl(project_store.project_dir(project_id)/"events.jsonl",{"time":_now(),"type":"face_crop_derivatives_created","revision":revision_id,"count":len(created),"filenames":[a["filename"] for a in created]}); return {"assets":created,"state":self.state(project_id,revision_id)}

    def append_operation(self, project_id: str, revision_id: str, filenames: list[str], operation: dict[str,Any]) -> dict[str,Any]:
        manifest_path,manifest=self._load(project_id,revision_id); wanted=set(filenames); found=[]; stamp={"recorded_at":_now(),**operation}
        for asset in manifest.get("assets",[]):
            if asset.get("filename") in wanted: asset.setdefault("operations",[]).append(stamp); found.append(str(asset["filename"]))
        missing=sorted(wanted-set(found))
        if missing: raise FileNotFoundError("Images not found in revision: "+", ".join(missing))
        _write_json(manifest_path,manifest); _append_jsonl(project_store.project_dir(project_id)/"events.jsonl",{"time":_now(),"type":"image_prep_operation_queued","revision":revision_id,"filenames":sorted(found),"operation":operation}); return self.state(project_id,revision_id)

    def materialize_run_dataset(self, project_id: str, revision_id: str, run: dict[str,Any]) -> dict[str,Any]:
        _,manifest=self._load(project_id,revision_id); source_dir=Path(manifest["files_path"]).resolve(); run_dir=Path(run["output_dir"]).resolve(); trainer_dir=run_dir/"dataset"
        if trainer_dir.exists(): shutil.rmtree(trainer_dir)
        trainer_dir.mkdir(parents=True); policy=manifest.get("training_resolution",DEFAULT_TRAINING_RESOLUTION); snapshot_assets=[]
        for asset in manifest.get("assets",[]):
            if not asset.get("included",True): continue
            filename=str(asset.get("filename","")); src=(source_dir/filename).resolve()
            if not filename or src.parent!=source_dir or not src.is_file(): continue
            transform=_effective_transform(manifest,asset); dst=trainer_dir/filename; transform_result=_materialize_transform(src,dst,transform); caption=str(asset.get("caption","")).strip(); dst.with_suffix(".txt").write_text(caption+("\n" if caption else ""),encoding="utf-8"); mw,mh=transform_result["materialized_size"]; bucket=_bucket_for(mw,mh,policy)
            snapshot_assets.append({"asset_id":asset.get("id"),"filename":filename,"project_image_sha256":asset.get("image_sha256") or _sha256(src),"trainer_image_sha256":_sha256(dst),"caption":caption,"caption_sha256":hashlib.sha256(caption.encode("utf-8")).hexdigest(),"origin":asset.get("origin"),"asset_kind":asset.get("asset_kind","source"),"parent_asset_id":asset.get("parent_asset_id"),"operations":asset.get("operations",[]),"global_transform":manifest.get("global_transform",DEFAULT_GLOBAL_TRANSFORM),"transform_override":asset.get("transform_override",{}),"effective_transform":transform,"materialized_transform":transform_result,"training_bucket":bucket})
        if not snapshot_assets: raise ValueError("Working dataset contains no included images")
        snapshot={"created_at":_now(),"project_id":project_id,"run_id":run["id"],"dataset_revision":revision_id,"dataset_is_scratch":True,"trainer_dataset_path":str(trainer_dir),"image_count":len(snapshot_assets),"global_transform":manifest.get("global_transform",DEFAULT_GLOBAL_TRANSFORM),"training_resolution":policy,"assets":snapshot_assets}; _write_json(run_dir/"dataset_snapshot.json",snapshot); run["dataset_path"]=str(trainer_dir); run["dataset_source_revision_path"]=str(source_dir); run["dataset_image_count"]=len(snapshot_assets); run.setdefault("config",{})["training_resolution"]=policy; _write_json(run_dir/"run.json",run)
        event={"time":_now(),"type":"trainer_dataset_materialized","revision":revision_id,"path":str(trainer_dir),"image_count":len(snapshot_assets),"training_resolution":policy,"transforms_materialized":True}; _append_jsonl(run_dir/"events.jsonl",event); _append_jsonl(project_store.project_dir(project_id)/"events.jsonl",{**event,"run_id":run["id"]}); return run


image_prep_store = ImagePrepStore()
