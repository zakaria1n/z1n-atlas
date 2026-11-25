from fastapi import FastAPI

from .bookings import router as bookings_router

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


def create_app():
    app.include_router(bookings_router)
