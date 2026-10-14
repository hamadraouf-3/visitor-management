"""A company's logo as its e-mails show it (Phase 13, B13-2 to B13-4): pictures of their own, drawn once
per process from the stored logos, that read in every mail client and in every colour scheme.

A stored logo is a transparent PNG drawn for a light surface (`logo`) or for a dark one (`logo_dark`).
Sent as it is, a transparent logo shows whatever the mail client puts behind it: a client that darkens
a message by itself (the Gmail apps, Outlook) or that honours a dark design turns the white header dark,
and a navy wordmark sinks into it (what the owner saw in Apple Mail on an iPhone). So the e-mails never
send a stored logo. They send **renditions**:

* the **light rendition**: the logo for light surfaces on a white plate, with `PLATE` CSS pixels of
  white baked around it; shown by default, and the only one the Gmail apps and Outlook for Windows ever
  show. On the white header the plate cannot be seen (the header's padding gives way by `PLATE`, so the
  logo's own edge stays where the text starts); where a client darkens the message, it is a white tile
  with rounded corners (`PLATE_RADIUS`, drawn by the client on the image);
* the **dark rendition**: the logo for dark surfaces, framed the same way in the exact colour of the
  dark design's header (`DARK_HEADER`), so it is seamless there; shown by the dark design only.

Both are **opaque**: 8-bit RGB without alpha (`app.core.png.encode_rgb_png`), so no client can show one
on black or let a darkened background through. Both are made smaller by area averaging to at most
`DENSITY` image pixels per CSS pixel of the header's box (`app.email.identity.fitted`), which also keeps
a large logo from travelling in full in every message.

A logo at most `EMBLEM_MAX_RATIO` (1.4) times as wide as it is tall is an emblem, a **mark** rather
than a wordmark: it does not say whose it is, so the header writes the company's name beside it, in
whichever design shows it (the web application's rule, `CompanyLogo.tsx`; B13-12).

**Drawn once, ahead.** Decoding a PNG in pure Python is slow (about two seconds for the largest logo an
upload may be, B13-3 and B13-7), so renditions are kept in this process, keyed by the SHA-256 of the
stored bytes and the colour they were drawn on: a new image is a new key, and nothing has to be told
that it changed. At most one rendition is drawn at a time; a second request for it waits for the first
and takes its result, so no e-mail and no preview draws one twice. The store is bounded by bytes
(`CACHE_BYTES`), least recently used first out. `LogoWarmUp` draws them before an e-mail needs them: a
company's after its logos changed, and every company's in the process that sends the e-mails.
"""

import hashlib
import logging
import threading
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.palette import to_rgb
from app.core.png import PngLimits, decode_png, encode_rgb_png
from app.core.raster import downscale, flatten, framed
from app.email.identity import fitted
from app.models import BrandAssetKind
from app.models.brand import BRAND_ASSET_MAX_BYTES, LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, LOGO_MIN_SIDE
from app.repositories.brand import CompanyBrandRepository

logger = logging.getLogger("app.email")

# White space baked around the logo in both renditions, in CSS pixels, and the corners a client draws
# on the light one's plate where it shows (a client that darkens the message, the dark design without a
# logo of its own for dark surfaces).
PLATE = 8
PLATE_RADIUS = 10
# Image pixels per CSS pixel, at most: sharp on high-density screens, and no heavier.
DENSITY = 2
# The two backgrounds a rendition is drawn on: the light header, and the dark design's header (the
# web application's dark surface, `index.css` theme-dark, which the dark e-mail's card is too).
LIGHT_HEADER = "#ffffff"
DARK_HEADER = "#182126"
# A logo at most this many times as wide as tall is an emblem, not a wordmark: the web application's
# `EMBLEM_MAX_RATIO` (frontend/src/components/app/CompanyLogo.tsx), compared exactly (`is_mark`).
EMBLEM_MAX_RATIO = 1.4
# Renditions kept in this process, by the bytes of their images (a rendition is a few KiB).
CACHE_BYTES = 8 * 1024 * 1024
# What a stored logo may be (B12-3): the check every stored logo passed, and decoding repeats it. Any bit
# depth: an upload has 8 bits a channel since B13-7, a logo stored before may have 16.
LOGO_LIMITS = PngLimits(
    min_width=LOGO_MIN_SIDE,
    max_width=LOGO_MAX_WIDTH,
    min_height=LOGO_MIN_SIDE,
    max_height=LOGO_MAX_HEIGHT,
    max_bytes=BRAND_ASSET_MAX_BYTES,
)


@dataclass(frozen=True, slots=True)
class Rendition:
    """A logo as an e-mail sends it: an opaque PNG of the logo on its plate."""

    content: bytes
    width: int  # shown, in CSS pixels, the plate included
    height: int
    mark: bool  # at most EMBLEM_MAX_RATIO as wide as tall: a mark, not a wordmark


def is_mark(width: int, height: int) -> bool:
    """Whether a logo of `width` x `height` pixels is a mark (it does not say whose it is): at most
    `EMBLEM_MAX_RATIO` as wide as it is tall, compared in integers (7 / 5), so no rounding decides."""
    return 5 * width <= 7 * height


def draw(content: bytes, background: str) -> Rendition:
    """The rendition of the stored logo `content` on `background` (`#rrggbb`), drawn now (see
    `rendition` for the one to use). Raises `app.core.png.PngError` for bytes that are no stored logo."""
    pixels = decode_png(content, LOGO_LIMITS)
    shown_width, shown_height = fitted(pixels.width, pixels.height)
    scale = min(1.0, DENSITY * shown_width / pixels.width, DENSITY * shown_height / pixels.height)
    width = max(1, round(pixels.width * scale))
    height = max(1, round(pixels.height * scale))
    margin = max(1, round(PLATE * width / shown_width))  # the plate at the image's own density
    colour = to_rgb(background)
    rgb = downscale(flatten(pixels, colour), pixels.width, pixels.height, width, height)
    image = framed(rgb, width, height, margin, colour)
    return Rendition(
        content=encode_rgb_png(width + 2 * margin, height + 2 * margin, image),
        width=shown_width + 2 * PLATE,
        height=shown_height + 2 * PLATE,
        mark=is_mark(pixels.width, pixels.height),
    )


class RenditionCache:
    """Renditions by the SHA-256 of the stored logo and the background, bounded by bytes."""

    def __init__(self, limit: int = CACHE_BYTES) -> None:
        self.limit = limit
        self._found: OrderedDict[tuple[bytes, str], Rendition] = OrderedDict()
        self._size = 0
        self._lock = threading.Lock()  # the table
        self._drawing = threading.Lock()  # one rendition drawn at a time
        self.drawn = 0  # renditions drawn by this cache (tests, measurements)

    def _get(self, key: tuple[bytes, str]) -> Rendition | None:
        with self._lock:
            found = self._found.get(key)
            if found is not None:
                self._found.move_to_end(key)
            return found

    def _put(self, key: tuple[bytes, str], rendition: Rendition) -> None:
        with self._lock:
            self._found[key] = rendition
            self._size += len(rendition.content)
            while self._size > self.limit and len(self._found) > 1:
                _key, oldest = self._found.popitem(last=False)
                self._size -= len(oldest.content)

    def rendition(self, content: bytes, background: str) -> Rendition:
        """The rendition of `content` on `background`, drawn the first time it is asked for."""
        key = (hashlib.sha256(content).digest(), background)
        found = self._get(key)
        if found is not None:
            return found
        with self._drawing:
            found = self._get(key)  # drawn while this request waited
            if found is None:
                found = draw(content, background)
                self.drawn += 1
                self._put(key, found)
        return found

    def clear(self) -> None:
        with self._lock:
            self._found.clear()
            self._size = 0


RENDITIONS = RenditionCache()


def light_rendition(content: bytes) -> Rendition:
    """The logo for light surfaces on its white plate."""
    return RENDITIONS.rendition(content, LIGHT_HEADER)


def dark_rendition(content: bytes) -> Rendition:
    """The logo for dark surfaces, seamless on the dark design's header."""
    return RENDITIONS.rendition(content, DARK_HEADER)


class LogoWarmUp:
    """Draws the renditions the e-mails send before they are needed (B13-7), in daemon threads. An e-mail
    is rendered inside the request that sends it (a check-in renders the host's notice while it holds the
    visit's row), where the first drawing of a logo after the process started, or after the logo
    changed, would otherwise be paid.

    * `company`: one company's renditions, after its logo for light or dark surfaces was stored or
      removed (the brand service calls it once the change is committed);
    * `everything`: every active company's, once per process, when the process takes its first write
      (`app.core.middleware.FirstWrite`). The process that takes the writes is the one that sends the
      e-mails: nginx sends the read services nothing but the GETs of its map (deploy/README.md §4), and
      the four processes share one command and one configuration (security review condition 4), so
      nothing else tells them apart.

    Each company's logos are read in a session of their own, closed before anything is drawn. Drawing
    goes through the e-mails' own store (`RENDITIONS`): a request that needs a rendition being drawn
    here waits for it and takes it, and one that needs another waits for the drawing in progress at most.
    A failure is logged and the next company is drawn; the e-mails draw whatever is missing on demand."""

    def __init__(self, sessions: Callable[[], Session], cache: RenditionCache | None = None) -> None:
        self.sessions = sessions
        self.cache = cache or RENDITIONS
        self._once = threading.Lock()
        self.started: threading.Thread | None = None  # the thread of `everything`, once it started

    def everything(self) -> threading.Thread:
        """Draw every active company's renditions in the background, once per process."""
        with self._once:
            if self.started is None:
                self.started = self._start(self._everything)
            return self.started

    def company(self, company_id: UUID) -> threading.Thread:
        """Draw one company's renditions in the background."""
        return self._start(self._companies, [company_id])

    def draw(self, company_id: UUID) -> None:
        """The company's renditions as its e-mails take them (`app.email.service.company_identity`): its
        logo for light surfaces on white, and its logo for dark surfaces on the dark header when it has
        both. Drawn now, unless the store has them."""
        with self.sessions() as db:
            brands = CompanyBrandRepository(db)
            logo = brands.image(company_id, BrandAssetKind.LOGO)
            logo_dark = brands.image(company_id, BrandAssetKind.LOGO_DARK) if logo else None
        if logo is not None:
            self.cache.rendition(logo.content, LIGHT_HEADER)
        if logo_dark is not None:
            self.cache.rendition(logo_dark.content, DARK_HEADER)

    def _start(self, target: Callable[..., None], *args: object) -> threading.Thread:
        thread = threading.Thread(target=target, args=args, name="email-logo-warm-up", daemon=True)
        thread.start()
        return thread

    def _everything(self) -> None:
        try:
            with self.sessions() as db:
                company_ids = CompanyBrandRepository(db).companies_with_logo()
        except Exception:
            logger.exception("e-mail logos not drawn ahead: the companies could not be read")
            return
        self._companies(company_ids)

    def _companies(self, company_ids: Iterable[UUID]) -> None:
        for company_id in company_ids:
            try:
                self.draw(company_id)
            except Exception:
                logger.exception(
                    "a company's e-mail logos not drawn ahead", extra={"company_id": str(company_id)}
                )
