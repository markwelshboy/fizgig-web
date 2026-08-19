from backend.app.face_crop_geometry import face_crop_box, validate_exact_aspect_box


ASPECTS = ("1:1", "4:5", "5:4", "9:16", "16:9")
IMAGE_SIZES = (
    (1024, 1024),
    (768, 1344),
    (1344, 768),
    (807, 1009),
)
FACE_BOXES = (
    (330, 250, 480, 430),
    (12, 18, 160, 190),
)


def _clip_face(image_size, bbox):
    width, height = image_size
    x1, y1, x2, y2 = bbox
    return max(0, x1), max(0, y1), min(width, x2), min(height, y2)


def test_face_crops_are_bounded_exact_aspect_and_contain_face():
    for image_size in IMAGE_SIZES:
        width, height = image_size
        for aspect in ASPECTS:
            for raw_face in FACE_BOXES:
                # Scale the fixture into each source so portrait/landscape images
                # exercise both central and near-edge positioning.
                sx = width / 1024.0
                sy = height / 1024.0
                bbox = tuple(
                    int(round(value * (sx if index % 2 == 0 else sy)))
                    for index, value in enumerate(raw_face)
                )
                crop = face_crop_box(image_size, bbox, 60.0, aspect)
                validate_exact_aspect_box(image_size, crop, aspect)
                face = _clip_face(image_size, bbox)
                assert crop[0] <= face[0] <= face[2] <= crop[2]
                assert crop[1] <= face[1] <= face[3] <= crop[3]


def test_detector_boxes_outside_image_are_clipped_before_portrait_crop():
    image_size = (768, 1344)
    crop = face_crop_box(image_size, (-24, 44, 190, 310), 60.0, "9:16")
    validate_exact_aspect_box(image_size, crop, "9:16")
    assert crop[0] == 0
    assert crop[1] >= 0
    assert crop[2] <= image_size[0]
    assert crop[3] <= image_size[1]


def test_more_padding_never_reduces_crop_area_when_source_has_room():
    image_size = (1024, 1024)
    bbox = (420, 390, 590, 580)
    for aspect in ASPECTS:
        small = face_crop_box(image_size, bbox, 20.0, aspect)
        large = face_crop_box(image_size, bbox, 80.0, aspect)
        small_area = (small[2] - small[0]) * (small[3] - small[1])
        large_area = (large[2] - large[0]) * (large[3] - large[1])
        assert large_area >= small_area
