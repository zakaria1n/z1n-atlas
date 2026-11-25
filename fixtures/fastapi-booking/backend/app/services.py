TOTAL_RATE = 2


def compute_total(minutes: int) -> int:
    return minutes * TOTAL_RATE


class BookingService:
    def quote(self, minutes: int) -> int:
        return compute_total(minutes)
