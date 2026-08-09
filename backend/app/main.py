from fastapi import FastAPI

app = FastAPI(title="Fizgig Web API", version="0.1.0")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/model-families")
def model_families() -> list[dict[str, object]]:
    return [
        {
            "id": "krea2",
            "name": "Krea 2",
            "features": {
                "per_image_loss": True,
                "per_image_lr": True,
                "auto_recaption": True,
            },
        },
        {
            "id": "klein",
            "name": "Klein 9B",
            "features": {
                "per_image_loss": False,
                "per_image_lr": False,
                "auto_recaption": False,
            },
        },
    ]
