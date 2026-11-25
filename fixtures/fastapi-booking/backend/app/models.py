from .database import Base


class Booking(Base):
    __tablename__ = "bookings"

    id: int
    guest: str
    minutes: int
