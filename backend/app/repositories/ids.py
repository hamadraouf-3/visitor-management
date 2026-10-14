"""Matching a column against a batch of IDs (the lookups behind every list of visits)."""

from collections.abc import Collection
from uuid import UUID

from sqlalchemy import ColumnElement, Uuid, any_, bindparam
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import InstrumentedAttribute

_UUID_ARRAY = ARRAY(Uuid())


def any_of(
    column: InstrumentedAttribute[UUID] | InstrumentedAttribute[UUID | None], ids: Collection[UUID]
) -> ColumnElement[bool]:
    """`column = ANY(:ids)`: the batch as one `uuid[]` parameter, which an index on the column serves
    like an IN list. An IN list has one parameter per ID, so its statement differs with the batch's
    length: SQLAlchemy renders it and psycopg parses it again for every call (it is too long for
    psycopg's statement cache). Measured on GET /reception/today's 250-visit lookups: about 2 ms of CPU
    less per lookup (re-audit round 1)."""
    return column == any_(bindparam(None, list(ids), type_=_UUID_ARRAY))
