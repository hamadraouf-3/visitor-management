"""Health schema (contract §8). The error envelope lives in `app.schemas.common`."""

from typing import Literal

from app.schemas.common import ResponseModel


class Health(ResponseModel):
    status: Literal["ok"]
    database: Literal["ok"]
