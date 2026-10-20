"""The words of every e-mail, in Arabic and English (Phase 10, B10-7).

Each e-mail is bilingual: the leading language first (in full, with the visitor pass), then the other one,
complete as well, so a reader of either language has every fact and instruction. Templates are written
once and render a section for a given language with `t(language, key, **values)`. The catalog text is
plain text: for HTML it is escaped and every value is escaped on its own (`translate_html`), so no
translated text can carry markup and no name can break out of it. Names, companies and addresses are
isolated from the sentence around them (`app.email.bidi`, B10-14); dates, times and durations, which the
service writes in the sentence's own language, are inserted as they are. Subjects use `translate`, which
inserts every value as it is.

English keeps the wording the e-mails had before Phase 10 where a sentence is still there (the product's
name replaced the old one; B10-19 removed explanatory filler that does not serve the reader). Arabic
is Modern Standard Arabic written for a Levantine audience; sentences start with an Arabic word, so mail
clients that pick a paragraph's direction from its first letter lay them out right to left even where a
Latin name follows. Second-person forms are unvowelled and so read for any reader; the
generic masculine is used for third persons (the host, the visitor), as Arabic interfaces do, but
never for a named person: a sentence whose subject is a name is worded without gender ("زائرك {visitor}
في الاستقبال", not a verb that agrees with a man). Checking in is «تسجيل الدخول», the interface's word.

`tests/unit/test_email_i18n.py` checks that every key has both languages with the same placeholders.
"""

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from string import Formatter

from markupsafe import Markup, escape

from app.email.bidi import Direction, isolate_html, isolate_text
from app.email.formatting import on_one_line
from app.models.enums import Language

AR, EN = Language.AR, Language.EN

DIRECTION: dict[Language, Direction] = {AR: "rtl", EN: "ltr"}

# How the value of each placeholder enters a sentence (B10-14). Every placeholder of the catalog is in one
# of these sets (a test checks it); one that is in none is isolated, the safe side.
# Names, companies, the brand and the product, typed by people or configured, in either script: isolated, in
# their own direction.
ISOLATED_VALUES = frozenset({"name", "visitor", "host", "booker", "company", "brand", "product", "sender"})
# Network addresses, links and e-mail addresses: isolated, always left to right.
LEFT_TO_RIGHT_VALUES = frozenset({"ip", "url", "email"})
# Written by the e-mail service in the sentence's own language (dates, times, zones, durations): inserted
# as they are. An Arabic time range reads right to left with the sentence (its start, 10:00, at the right
# of its end, 11:00); isolating it as left-to-right text would show the end first.
FORMATTED_VALUES = frozenset({"date", "time", "zone", "start", "end", "duration", "sent_at"})
# Characters that end a sentence. A sentence that ends with a value ("... on behalf of {company}.") drops
# its own full stop when the value already ends with one of these ("ACME Inc."), so it never shows two.
_VALUE_AND_FULL_STOP = re.compile(r"\{(\w+)\}\.")
SENTENCE_END = (".", "!", "?", "\N{HORIZONTAL ELLIPSIS}", "\N{ARABIC QUESTION MARK}")
# The name of each language in its own script, for the heading of its section.
LANGUAGE_NAMES = {AR: "العربية", EN: "English"}

MESSAGES: dict[str, dict[Language, str]] = {
    # ---- shared ------------------------------------------------------------------------------------
    "common.hello": {EN: "Hello {name},", AR: "مرحبًا {name}،"},
    "common.button_fallback": {
        EN: "If the button does not work, copy this link into your browser:",
        AR: "إن لم يعمل الزر، انسخ هذا الرابط والصقه في المتصفح:",
    },
    "common.address_fallback": {
        EN: "If the button does not work, copy this address into your browser:",
        AR: "إن لم يعمل الزر، انسخ هذا العنوان والصقه في المتصفح:",
    },
    # Who sent a company's e-mail (B12-12): the company, and nobody else.
    "footer.company": {EN: "Sent by {company}.", AR: "أُرسلت من {company}."},
    # Who sent the product's own e-mail, the CLI's test message (B10-16). No e-mail to a company's people
    # names the product (B12-22).
    "footer.sent": {EN: "Sent by {product}.", AR: "أُرسلت عبر {product}."},
    "footer.no_reply": {EN: "Please do not reply to this email.", AR: "يُرجى عدم الرد على هذه الرسالة."},
    # ---- detail labels -----------------------------------------------------------------------------
    "label.date": {EN: "Date", AR: "التاريخ"},
    "label.time": {EN: "Time", AR: "الوقت"},
    "label.host": {EN: "Host", AR: "المضيف"},
    "label.department": {EN: "Department", AR: "القسم"},
    "label.address": {EN: "Address", AR: "العنوان"},
    "label.invited_by": {EN: "Invited by", AR: "مُرسِل الدعوة"},
    "label.purpose": {EN: "Purpose", AR: "الغرض من الزيارة"},
    "label.purpose_note": {EN: "provided by your host", AR: "كما ذكره مضيفك"},
    "label.visitor": {EN: "Visitor", AR: "الزائر"},
    "label.company": {EN: "Company", AR: "الشركة"},
    "label.scheduled": {EN: "Scheduled", AR: "الموعد"},
    "label.reason": {EN: "Reason given", AR: "السبب المذكور"},
    "label.check_in_from": {EN: "Check in from", AR: "تسجيل الدخول من"},
    "label.expires_at": {EN: "Pass expires", AR: "تنتهي صلاحية البطاقة"},
    "label.administrator": {EN: "Administrator", AR: "مدير النظام"},
    "label.email": {EN: "Email address", AR: "البريد الإلكتروني"},
    # ---- visitor invitation ------------------------------------------------------------------------
    "invitation.kind": {EN: "Visit invitation", AR: "دعوة زيارة"},
    "invitation.subject": {EN: "Your visit to {company} on {date}", AR: "زيارتك إلى {company} يوم {date}"},
    "invitation.preheader": {
        EN: "Your visitor pass for {date} at {company}. Show the QR code at reception when you arrive.",
        AR: "بطاقة زيارتك إلى {company} يوم {date}. اعرض رمز QR عند الاستقبال لدى وصولك.",
    },
    "invitation.heading": {EN: "Your visit to {company}", AR: "زيارتك إلى {company}"},
    "invitation.invited": {
        EN: "{host} has invited you to visit {company}.",
        AR: "تلقّيت دعوةً من {host} لزيارة {company}.",
    },
    "invitation.invited_on_behalf": {
        EN: "{booker} has invited you to visit {company} on behalf of {host}.",
        AR: "تلقّيت دعوةً من {booker} نيابةً عن {host} لزيارة {company}.",
    },
    "invitation.pass_label": {EN: "Your visitor pass", AR: "بطاقة الزيارة"},
    "invitation.pass_title": {EN: "Show this QR code at reception", AR: "اعرض هذا الرمز عند الاستقبال"},
    "invitation.present_above": {
        EN: "Please present the QR code above at reception when you arrive.",
        AR: "يُرجى إبراز رمز QR أعلاه عند الاستقبال لدى وصولك.",
    },
    # `{start}` and `{end}` are `VisitTimes.from_phrase` and `until_phrase`: a time on the visit's day
    # («عند 12:00»: the Arabic preposition comes with the value), or another day's moment as a sentence
    # says it («يوم الثلاثاء 6 تشرين الأول الساعة 00:30», B12-23).
    "invitation.window": {
        EN: "You can check in from {start}. Your pass expires at {end} ({zone}).",
        AR: "يمكنك تسجيل الدخول ابتداءً من {start}، وتنتهي صلاحية بطاقتك {end} ({zone}).",
    },
    "invitation.qr_alt": {
        EN: "QR code of your visitor pass for {company}",
        AR: "رمز QR لبطاقة زيارتك إلى {company}",
    },
    "invitation.open_pass": {EN: "Open my visitor pass", AR: "عرض بطاقة الزيارة"},
    "invitation.text_pass": {
        EN: "Show the QR code of your visitor pass at reception when you arrive. Open your pass here:",
        AR: "اعرض رمز QR الخاص ببطاقة زيارتك عند الاستقبال لدى وصولك. افتح بطاقتك من هنا:",
    },
    "invitation.personal": {
        EN: "This pass is personal. Please do not forward this email.",
        AR: "هذه البطاقة شخصية، يُرجى عدم إعادة توجيه هذه الرسالة.",
    },
    "invitation.arrival_heading": {EN: "When you arrive", AR: "عند الوصول"},
    "invitation.step_id": {EN: "Bring a valid photo ID.", AR: "أحضِر بطاقة هوية سارية تحمل صورتك."},
    "invitation.step_reception": {
        EN: "Go to the reception desk and show this QR code on your phone or on a printout.",
        AR: "توجّه إلى مكتب الاستقبال واعرض رمز QR من هاتفك أو مطبوعًا على ورق.",
    },
    "invitation.step_notify": {
        EN: "Reception will check you in and let {host} know that you have arrived.",
        AR: "سيسجّل الاستقبال دخولك ويُعلم {host} بقدومك.",
    },
    "invitation.step_contact": {
        EN: "Reception will check you in and contact your host.",
        AR: "سيسجّل الاستقبال دخولك ويتواصل مع مضيفك.",
    },
    "invitation.questions_host": {
        EN: "Questions, or running late? Reply to this email to reach {host}.",
        AR: "لديك سؤال أو ستتأخر؟ ردّ على هذه الرسالة للتواصل مع {host}.",
    },
    "invitation.questions_reply": {
        EN: "Questions, or running late? Reply to this email.",
        AR: "لديك سؤال أو ستتأخر؟ ردّ على هذه الرسالة.",
    },
    "invitation.questions_contact": {
        EN: "Questions, or running late? Please contact {host}.",
        AR: "لديك سؤال أو ستتأخر؟ يُرجى التواصل مع {host}.",
    },
    # ---- visit rescheduled -------------------------------------------------------------------------
    "rescheduled.kind": {EN: "Visit rescheduled", AR: "تغيير موعد الزيارة"},
    "rescheduled.subject": {
        EN: "Your visit to {company} has been rescheduled",
        AR: "تغيّر موعد زيارتك إلى {company}",
    },
    "rescheduled.preheader": {
        EN: "New time: {date}, {time}. Your existing QR code remains valid.",
        AR: "الموعد الجديد: {date}، {time}. رمز QR الذي لديك ما زال صالحًا.",
    },
    "rescheduled.heading": {EN: "Your visit has been rescheduled", AR: "تغيّر موعد زيارتك"},
    "rescheduled.intro": {
        EN: "The time of your visit to {company} with {host} has changed.",
        AR: "تغيّر موعد زيارتك إلى {company} مع {host}.",
    },
    "rescheduled.still_valid": {
        EN: "Your existing QR code remains valid.",
        AR: "رمز QR الذي لديك ما زال صالحًا.",
    },
    "rescheduled.window": {
        EN: "You can now check in from {start}. Your pass expires at {end} ({zone}).",
        AR: "يمكنك الآن تسجيل الدخول ابتداءً من {start}، وتنتهي صلاحية بطاقتك {end} ({zone}).",
    },
    "rescheduled.questions_host": {
        EN: "If you have any questions about your visit, reply to this email to reach {host}.",
        AR: "إن كان لديك أي سؤال عن زيارتك، ردّ على هذه الرسالة للتواصل مع {host}.",
    },
    "rescheduled.questions_reply": {
        EN: "If you have any questions about your visit, reply to this email.",
        AR: "إن كان لديك أي سؤال عن زيارتك، ردّ على هذه الرسالة.",
    },
    "rescheduled.questions_contact": {
        EN: "If you have any questions about your visit, please contact {host}.",
        AR: "إن كان لديك أي سؤال عن زيارتك، يُرجى التواصل مع {host}.",
    },
    # ---- visit cancelled ---------------------------------------------------------------------------
    "cancelled.kind": {EN: "Visit cancelled", AR: "إلغاء الزيارة"},
    "cancelled.subject": {
        EN: "Your visit to {company} has been cancelled",
        AR: "أُلغيت زيارتك إلى {company}",
    },
    "cancelled.preheader": {
        EN: "Your visit on {date} has been cancelled.",
        AR: "أُلغيت زيارتك المقرّرة يوم {date}.",
    },
    "cancelled.heading": {EN: "Your visit has been cancelled", AR: "أُلغيت زيارتك"},
    "cancelled.intro": {
        EN: "Your visit to {company} with {host} has been cancelled.",
        AR: "أُلغيت زيارتك إلى {company} مع {host}.",
    },
    "cancelled.no_longer_valid": {
        EN: "Your visitor pass for this visit is no longer valid.",
        AR: "لم تعد بطاقة الزيارة الخاصة بهذه الزيارة صالحة.",
    },
    "cancelled.questions_host": {
        EN: "If you have any questions, reply to this email to reach {host}.",
        AR: "إن كان لديك أي سؤال، ردّ على هذه الرسالة للتواصل مع {host}.",
    },
    "cancelled.questions_reply": {
        EN: "If you have any questions, reply to this email.",
        AR: "إن كان لديك أي سؤال، ردّ على هذه الرسالة.",
    },
    "cancelled.questions_contact": {
        EN: "If you have any questions, please contact {company}.",
        AR: "إن كان لديك أي سؤال، يُرجى التواصل مع {company}.",
    },
    # ---- host arrival ------------------------------------------------------------------------------
    "arrival.kind": {EN: "Visitor arrived", AR: "وصول زائر"},
    "arrival.subject": {EN: "Your visitor {visitor} has arrived", AR: "زائرك {visitor} في الاستقبال"},
    "arrival.preheader": {EN: "{visitor} checked in at {time}.", AR: "سُجّل دخول {visitor} الساعة {time}."},
    "arrival.heading": {EN: "Your visitor has arrived", AR: "زائرك في الاستقبال"},
    "arrival.body": {
        EN: "Your visitor {visitor} has arrived and checked in at reception at {time} ({zone}).",
        AR: "زائرك {visitor} في الاستقبال، وقد سُجّل الدخول الساعة {time} ({zone}).",
    },
    "arrival.meet": {
        EN: "Please meet your visitor at reception.",
        AR: "يُرجى التوجّه لملاقاة زائرك عند مكتب الاستقبال.",
    },
    # ---- the host's visit: new, a new time, cancelled (Phase 14, B14-2) ----------------------------
    # The host's own e-mails of a scheduled visit, each carrying the visit as an event of the host's
    # calendar. `{time}` is the visit's time range here, never a check-in time.
    "host_scheduled.kind": {EN: "New visit", AR: "زيارة جديدة"},
    "host_scheduled.subject": {EN: "New visit: {visitor} on {date}", AR: "زيارة جديدة: {visitor} يوم {date}"},
    "host_scheduled.preheader": {
        EN: "A visit from {visitor} on {date}, {time}.",
        AR: "زيارة من {visitor} يوم {date}، {time}.",
    },
    "host_scheduled.heading": {EN: "You have a new visit", AR: "لديك زيارة جديدة"},
    "host_scheduled.intro": {
        EN: "You have a visit from {visitor} on {date}, {time} ({zone}).",
        AR: "لديك زيارة من {visitor} يوم {date}، {time} ({zone}).",
    },
    "host_rescheduled.kind": {EN: "Visit rescheduled", AR: "تغيير موعد الزيارة"},
    "host_rescheduled.subject": {
        EN: "Visit rescheduled: {visitor} on {date}",
        AR: "تغيّر موعد زيارة {visitor} إلى يوم {date}",
    },
    "host_rescheduled.preheader": {EN: "New time: {date}, {time}.", AR: "الموعد الجديد: {date}، {time}."},
    "host_rescheduled.heading": {EN: "A visit has been rescheduled", AR: "تغيّر موعد زيارة"},
    "host_rescheduled.intro": {
        EN: "The visit of {visitor} has a new time: {date}, {time} ({zone}).",
        AR: "تغيّر موعد زيارة {visitor}، والموعد الجديد يوم {date}، {time} ({zone}).",
    },
    "host_cancelled.kind": {EN: "Visit cancelled", AR: "إلغاء الزيارة"},
    "host_cancelled.subject": {
        EN: "Visit cancelled: {visitor} on {date}",
        AR: "أُلغيت زيارة {visitor} يوم {date}",
    },
    "host_cancelled.preheader": {
        EN: "The visit on {date} has been cancelled.",
        AR: "أُلغيت الزيارة المقرّرة يوم {date}.",
    },
    "host_cancelled.heading": {EN: "A visit has been cancelled", AR: "أُلغيت زيارة"},
    "host_cancelled.intro": {
        EN: "The visit of {visitor} on {date}, {time} ({zone}) has been cancelled.",
        AR: "أُلغيت زيارة {visitor} المقرّرة يوم {date}، {time} ({zone}).",
    },
    "label.booked_by": {EN: "Booked by", AR: "الحجز بواسطة"},
    # ---- the visit as a calendar event (Phase 14, B14-3) -------------------------------------------
    # The one line of an invitation that says what the event attached to it is for.
    "calendar.attached": {
        EN: "The visit is attached for your calendar.",
        AR: "الزيارة مرفقة لإضافتها إلى تقويمك.",
    },
    # The event's summary in the visitor's calendar and in the host's, and the description's last line in
    # the visitor's. No link: the pass link is a credential, and calendars are shared (B14-4).
    "calendar.visitor_summary": {EN: "Visit to {company}", AR: "زيارة إلى {company}"},
    "calendar.host_summary": {EN: "Visit: {visitor}", AR: "زيارة: {visitor}"},
    "calendar.show_pass": {
        EN: "Show your visitor pass at reception when you arrive.",
        AR: "اعرض بطاقة زيارتك عند الاستقبال لدى وصولك.",
    },
    # The summary of the event taken out of the calendar of an address the visitor no longer has (D-19,
    # B14-17): it names nothing, since the address may be nobody the visit concerns.
    "calendar.withdrawn_summary": {EN: "Visit", AR: "زيارة"},
    # ---- the visit taken out of the calendar of an address the visitor no longer has (B14-17) ---------
    "withdrawn.kind": {EN: "Invitation withdrawn", AR: "سحب الدعوة"},
    "withdrawn.subject": {EN: "Visit invitation withdrawn", AR: "سحب دعوة الزيارة"},
    "withdrawn.heading": {EN: "This visit invitation has been withdrawn", AR: "سُحبت دعوة الزيارة هذه"},
    "withdrawn.intro": {
        EN: "The visit has been removed from your calendar.",
        AR: "أُزيلت الزيارة من تقويمك.",
    },
    # ---- password reset ----------------------------------------------------------------------------
    "reset.kind": {EN: "Password reset", AR: "إعادة تعيين كلمة المرور"},
    "reset.subject": {
        EN: "Reset your {company} account password",
        AR: "إعادة تعيين كلمة مرور حسابك في {company}",
    },
    "reset.preheader": {
        EN: "Choose a new password. This link expires in {duration}.",
        AR: "اختر كلمة مرور جديدة. تنتهي صلاحية هذا الرابط خلال {duration}.",
    },
    "reset.heading": {EN: "Reset your password", AR: "إعادة تعيين كلمة المرور"},
    "reset.intro": {
        EN: "We received a request to reset the password for your {company} account.",
        AR: "تلقّينا طلبًا لإعادة تعيين كلمة مرور حسابك في {company}.",
    },
    "reset.intro_text": {
        EN: "We received a request to reset the password for your {company} account. Open the link below to "
        "choose a new password:",
        AR: "تلقّينا طلبًا لإعادة تعيين كلمة مرور حسابك في {company}. افتح الرابط أدناه لاختيار كلمة مرور "
        "جديدة:",
    },
    "reset.button": {EN: "Reset password", AR: "إعادة تعيين كلمة المرور"},
    "reset.expiry": {
        EN: "This link expires in {duration} and can be used once.",
        AR: "تنتهي صلاحية هذا الرابط خلال {duration}، ويمكن استخدامه مرة واحدة.",
    },
    "reset.ignore": {
        EN: "If you did not request this, ignore this email. Your password will not change.",
        AR: "إن لم تطلب ذلك، فتجاهل هذه الرسالة، ولن تتغيّر كلمة مرورك.",
    },
    # The same link, sent by the platform owner to a company's administrator (B11-11): nobody "requested"
    # it, so the two sentences that say who asked have a wording of their own (B11-49).
    "reset.platform_intro": {
        EN: "The platform owner sent you a link to set a new password for your {company} account.",
        AR: "أرسل إليك مالك المنصة رابطًا لتعيين كلمة مرور جديدة لحسابك في {company}.",
    },
    "reset.platform_intro_text": {
        EN: "The platform owner sent you a link to set a new password for your {company} account. Open the "
        "link below to choose a new password:",
        AR: "أرسل إليك مالك المنصة رابطًا لتعيين كلمة مرور جديدة لحسابك في {company}. افتح الرابط أدناه "
        "لاختيار كلمة مرور جديدة:",
    },
    "reset.platform_ignore": {
        EN: "If you do not need a new password, ignore this email. Your password will not change.",
        AR: "إن لم تكن بحاجة إلى كلمة مرور جديدة، فتجاهل هذه الرسالة، ولن تتغيّر كلمة مرورك.",
    },
    # ---- password changed or reset (SEC-06) --------------------------------------------------------
    "changed.kind": {EN: "Security notice", AR: "تنبيه أمني"},
    "changed.subject.changed": {
        EN: "Your {company} account password was changed",
        AR: "تم تغيير كلمة مرور حسابك في {company}",
    },
    "changed.subject.reset": {
        EN: "Your {company} account password was reset",
        AR: "تمت إعادة تعيين كلمة مرور حسابك في {company}",
    },
    "changed.preheader.changed": {
        EN: "Your password was changed on {date} at {time}.",
        AR: "تم تغيير كلمة مرورك يوم {date} الساعة {time}.",
    },
    "changed.preheader.reset": {
        EN: "Your password was reset on {date} at {time}.",
        AR: "تمت إعادة تعيين كلمة مرورك يوم {date} الساعة {time}.",
    },
    "changed.heading.changed": {EN: "Your password was changed", AR: "تم تغيير كلمة مرورك"},
    "changed.heading.reset": {EN: "Your password was reset", AR: "تمت إعادة تعيين كلمة مرورك"},
    "changed.body.changed": {
        EN: "The password of your {company} account was changed on {date} at {time} ({zone}). You were "
        "signed out of your other sessions.",
        AR: "تم تغيير كلمة مرور حسابك في {company} يوم {date} الساعة {time} ({zone}). وقد سُجّل خروجك من "
        "جلساتك الأخرى.",
    },
    "changed.body.changed_ip": {
        EN: "The password of your {company} account was changed on {date} at {time} ({zone}) from the "
        "network address {ip}. You were signed out of your other sessions.",
        AR: "تم تغيير كلمة مرور حسابك في {company} يوم {date} الساعة {time} ({zone}) من عنوان الشبكة {ip}. "
        "وقد سُجّل خروجك من جلساتك الأخرى.",
    },
    "changed.body.reset": {
        EN: "The password of your {company} account was reset on {date} at {time} ({zone}). You were signed "
        "out of your other sessions.",
        AR: "تمت إعادة تعيين كلمة مرور حسابك في {company} يوم {date} الساعة {time} ({zone}). وقد سُجّل خروجك "
        "من جلساتك الأخرى.",
    },
    "changed.body.reset_ip": {
        EN: "The password of your {company} account was reset on {date} at {time} ({zone}) from the network "
        "address {ip}. You were signed out of your other sessions.",
        AR: "تمت إعادة تعيين كلمة مرور حسابك في {company} يوم {date} الساعة {time} ({zone}) من عنوان الشبكة "
        "{ip}. وقد سُجّل خروجك من جلساتك الأخرى.",
    },
    "changed.act": {
        EN: "If you did not make this change, reset your password now and tell your administrator.",
        AR: "إن لم تُجرِ هذا التغيير بنفسك، فأعد تعيين كلمة المرور الآن وأبلغ مدير النظام.",
    },
    # ---- an action of the platform owner on an administrator account (B11-43) ----------------------
    # To the company's other administrators, in the company's own identity (B12-22). The platform owner
    # is named by that role, never by the platform account's name (B11-5) and never by the product's.
    # No link and no credential: there is nothing to click.
    "platform.kind": {EN: "Security notice", AR: "تنبيه أمني"},
    "platform.subject.admin_added": {
        EN: "A new administrator was added to {company}",
        AR: "أُضيف مدير نظام جديد إلى {company}",
    },
    "platform.subject.reset_sent": {
        EN: "A password-reset link was sent to an administrator of {company}",
        AR: "أُرسل رابط لإعادة تعيين كلمة المرور إلى أحد مديري النظام في {company}",
    },
    "platform.preheader.admin_added": {
        EN: "The platform owner added an administrator on {date} at {time}.",
        AR: "أضاف مالك المنصة مدير نظام يوم {date} الساعة {time}.",
    },
    "platform.preheader.reset_sent": {
        EN: "The platform owner sent a password-reset link on {date} at {time}.",
        AR: "أرسل مالك المنصة رابطًا لإعادة تعيين كلمة المرور يوم {date} الساعة {time}.",
    },
    "platform.heading.admin_added": {EN: "A new administrator was added", AR: "أُضيف مدير نظام جديد"},
    "platform.heading.reset_sent": {
        EN: "A password-reset link was sent",
        AR: "أُرسل رابط لإعادة تعيين كلمة المرور",
    },
    "platform.body.admin_added": {
        EN: "The platform owner added a new administrator account to {company} on {date} at {time} ({zone}).",
        AR: "أضاف مالك المنصة حسابًا جديدًا لمدير نظام في {company} يوم {date} الساعة {time} ({zone}).",
    },
    "platform.body.reset_sent": {
        EN: "The platform owner sent a password-reset link to an administrator of {company} on {date} at "
        "{time} ({zone}).",
        AR: "أرسل مالك المنصة رابطًا لإعادة تعيين كلمة المرور إلى أحد مديري النظام في {company} يوم {date} "
        "الساعة {time} ({zone}).",
    },
    "platform.act": {
        EN: "If you did not expect this, contact the platform owner and review your company's "
        "administrators.",
        AR: "إن لم تكن تتوقع ذلك، فتواصل مع مالك المنصة وراجع قائمة مديري النظام في شركتك.",
    },
    # ---- test e-mail (python -m app.cli send-test-email, S10-6) ------------------------------------
    "test.kind": {EN: "Test message", AR: "رسالة تجريبية"},
    "test.subject": {EN: "Test e-mail from {sender}", AR: "رسالة تجريبية من {sender}"},
    "test.preheader": {
        EN: "Your e-mail settings work. This message was sent on {sent_at}.",
        AR: "إعدادات البريد الإلكتروني تعمل. أُرسلت هذه الرسالة في {sent_at}.",
    },
    "test.heading": {EN: "Your e-mail settings work", AR: "إعدادات البريد الإلكتروني تعمل"},
    "test.intro": {
        EN: "This is a test message from {product}, sent on {sent_at}.",
        AR: "هذه رسالة تجريبية من {product}، أُرسلت في {sent_at}.",
    },
    "test.sample_text": {
        EN: "The HTML version of this message shows a sample QR code, which is not a visitor pass. It opens "
        "the address real invitations use for visitor passes:",
        AR: "تعرض نسخة HTML من هذه الرسالة رمز QR تجريبيًا ليس بطاقة زيارة، وهو يفتح العنوان الذي تستخدمه "
        "الدعوات الحقيقية لبطاقات الزيارة:",
    },
    "test.sample_alt": {EN: "Sample QR code", AR: "رمز QR تجريبي"},
    "test.not_a_pass": {EN: "This is a sample, not a visitor pass.", AR: "هذا مثال وليس بطاقة زيارة."},
    "test.opens": {
        EN: "The sample opens the address real invitations use for visitor passes:",
        AR: "يفتح المثال العنوان الذي تستخدمه الدعوات الحقيقية لبطاقات الزيارة:",
    },
    "test.reachable": {
        EN: "Visitors open their pass from their phones, so {url} must be an address a phone can reach.",
        AR: "يفتح الزوار بطاقاتهم من هواتفهم، لذا يجب أن يكون {url} عنوانًا يمكن للهاتف الوصول إليه.",
    },
}


def placeholders(text: str) -> frozenset[str]:
    """The `{name}` fields of a catalog text."""
    return frozenset(name for _, name, _, _ in Formatter().parse(text) if name)


def catalog_text(language: Language, key: str, values: Mapping[str, object]) -> str:
    """The catalog text of `key`, without the full stop that follows a value which already ends a sentence:
    "on behalf of ACME Inc." rather than "on behalf of ACME Inc..", wherever the sentence ends."""

    def full_stop(match: re.Match[str]) -> str:
        value = values.get(match.group(1))
        ends = isinstance(value, str) and value.rstrip().endswith(SENTENCE_END)
        return match.group(0)[:-1] if ends else match.group(0)

    return _VALUE_AND_FULL_STOP.sub(full_stop, MESSAGES[key][language])


def translate(language: Language | str, key: str, /, **values: object) -> str:
    """The text of `key` in `language` with `values` inserted as they are: for subjects (headers carry no
    isolate characters). An unknown key or a missing value raises, so a template cannot render a hole.
    A subject is one line, read and searched as typed: the no-break spaces that keep an Arabic date on one
    line in a body (`app.email.formatting`) are plain spaces here."""
    lang = Language(language)
    return catalog_text(lang, key, values).format(**values).replace("\N{NO-BREAK SPACE}", " ")


def _isolated(
    language: Language,
    values: Mapping[str, object],
    isolate: Callable[[str, Direction, Direction | None], object],
) -> dict[str, object]:
    context = DIRECTION[language]
    return {
        name: isolate(value, context, "ltr" if name in LEFT_TO_RIGHT_VALUES else None)
        if isinstance(value, str) and name not in FORMATTED_VALUES
        else value
        for name, value in values.items()
    }


def translate_text(language: Language | str, key: str, /, **values: object) -> str:
    """`translate` for a plain-text body or an HTML attribute: names, companies and addresses isolated
    with Unicode isolate characters (`app.email.bidi.isolate_text`)."""
    lang = Language(language)
    return catalog_text(lang, key, values).format(**_isolated(lang, values, isolate_text))


def translate_html(language: Language | str, key: str, /, **values: object) -> Markup:
    """`translate` for HTML: the catalog text escaped, every value escaped on its own, and names,
    companies and addresses each in a `<span dir>` of their own (`app.email.bidi.isolate_html`). A
    formatted value that holds a time range stays on one line (`formatting.on_one_line`, B11-47)."""
    lang = Language(language)
    prepared = _isolated(lang, values, isolate_html)
    for name, value in values.items():
        if name in FORMATTED_VALUES and isinstance(value, str):
            prepared[name] = on_one_line(value)
    return escape(catalog_text(lang, key, values)).format(**prepared)


@dataclass(frozen=True, slots=True)
class Sentence:
    """A catalog text with its values, for a template to render with `t` (and so with its values
    isolated): the footers are built from these."""

    key: str
    values: Mapping[str, object] = field(default_factory=dict)


def other_language(language: Language) -> Language:
    return EN if language == AR else AR


def as_language(value: str | None, *fallbacks: str | None) -> Language:
    """The first of `value` and `fallbacks` that is a language, else Arabic (the product's default)."""
    for candidate in (value, *fallbacks):
        if candidate in (AR.value, EN.value):
            return Language(candidate)
    return AR


def minutes(language: Language, count: int) -> str:
    """`30 minutes` / `30 دقيقة`, with Arabic's number agreement (1, 2, 3-10, 11+)."""
    if language == EN:
        return f"{count} minute" if count == 1 else f"{count} minutes"
    if count == 1:
        return "دقيقة واحدة"
    if count == 2:
        return "دقيقتين"
    if 3 <= count <= 10:
        return f"{count} دقائق"
    return f"{count} دقيقة"
