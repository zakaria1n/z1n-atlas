from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import Booking
from .services import compute_total

router = APIRouter(prefix="/api", tags=["reservations"])


def get_session() -> Session:
    raise NotImplementedError


@router.post("/bookings", status_code=201)
async def create_booking(payload: dict, db: Session = Depends(get_session)):
    booking = Booking(guest=payload["guest"], minutes=payload["minutes"])
    db.add(booking)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise
    db.commit()
    return {"total": compute_total(booking.minutes), "id": booking.id}


@router.get("/bookings/{booking_id}")
async def read_booking(booking_id: int, db: Session = Depends(get_session)):
    return db.get(Booking, booking_id)
