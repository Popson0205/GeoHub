"""Send the renewal reminders due today (the server also does this by itself every hour).

    python3 -m app.ops.renewal_reminders [YYYY-MM-DD]
"""
import asyncio
import sys
from datetime import date

from .. import logging_setup, reminders
from ..db import pool


async def main(today: date | None) -> int:
    await pool.open()
    try:
        async with pool.connection() as conn:
            return await reminders.run(conn, today)
    finally:
        await pool.close()


if __name__ == "__main__":
    logging_setup.setup()
    day = date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else None
    print(f"Reminded {asyncio.run(main(day))} organization(s).")
