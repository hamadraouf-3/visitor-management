"""The caller's own preferences: PATCH /api/v1/auth/preferences (Phase 10, B10-3).

One preference today, the language of the interface and of the e-mails the user receives
(`users.preferred_language`; NULL follows the company's `default_language`). Every signed-in user may set
their own, also while a password change is required, so the forced-change screen can switch language.
The request runs under the same session, CSRF and Origin rules as every unsafe request and spends only
the per-user API budget.

Not audited (B10-4): a language choice changes nothing a reviewer of the audit log needs (no access, no
data, no visit), and an append-only row per switch would let one session add up to the per-user API
budget's 600 rows a minute (the flood the audit log's controls exist to prevent, docs/security.md §8.5).
"""

from sqlalchemy.orm import Session

from app.models import Language, User
from app.security.sessions import AuthContext


class PreferencesService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def set_language(self, auth: AuthContext, language: Language) -> User:
        """Store `language` as the caller's own; a repeated value writes nothing."""
        user = auth.user
        if user.preferred_language != language.value:
            user.preferred_language = language.value
            self.db.commit()
        return user
