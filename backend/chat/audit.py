"""Запись событий по участникам сервера в журнал модерации.

Единственная точка, через которую пишется chat.models.ServerAuditLog —
вызывается из chat/views.py в местах, где событие РЕАЛЬНО произошло (после
успешной проверки прав и самого действия), а не из сигналов модели: сигнал
не знает ни кто действовал, ни причины бана, ни того, была ли это заявка или
ссылка — а без этого запись бесполезна.

Что сюда НЕ пишется: счётчики сообщений/ссылок/медиа. Их панель модератора
считает запросом по chat.models.Message (см. ServerMemberModeratorView) —
так они верны и для истории, накопленной до появления журнала.
"""
import logging

from .models import ServerAuditLog

logger = logging.getLogger(__name__)


def log(server, actor, target, action, **details) -> None:
    """Записать событие. actor — кто действовал (для join/leave это сам
    target), target — о ком запись, details — произвольные подробности
    действия (см. ServerAuditLog.details).

    Никогда не бросает наружу: журнал — побочный эффект модерации, и
    упавшая запись в него не должна отменять сам кик/бан/выдачу роли,
    которые к этому моменту уже применены к БД.
    """
    try:
        ServerAuditLog.objects.create(
            server=server, actor=actor, target=target,
            action=action, details=details,
        )
    except Exception:
        logger.exception("Не удалось записать в журнал аудита: %s", action)


def record_join(membership, created, method, invite_code="", invited_by=None) -> None:
    """Вступление на сервер: проставляет способ на самом членстве и пишет
    запись в журнал. Оба действия вместе, одним вызовом из каждой из четырёх
    вьюх вступления (см. chat.views) — разнеси их, и рано или поздно новая
    ветка вступления запишет одно и забудет другое.

    created=False — человек уже был участником (get_or_create ничего не
    создал, повторный переход по своей же ссылке). Тогда ни поля, ни журнал
    не трогаем: это не новое вступление, а холостой запрос, и затирать им
    настоящий способ вступления нельзя.
    """
    if not created:
        return
    membership.join_method = method
    membership.join_invite_code = invite_code
    membership.join_invited_by = invited_by
    membership.save(update_fields=[
        "join_method", "join_invite_code", "join_invited_by"])
    log(membership.server, membership.user, membership.user, ServerAuditLog.JOIN,
        method=method, invite_code=invite_code,
        invited_by_id=invited_by.id if invited_by else None,
        invited_by_username=invited_by.username if invited_by else "")


def log_role_changes(server, actor, target, before, after) -> None:
    """Разница двух наборов ролей — отдельными записями «выдана»/«снята».

    before/after — списки объектов Role. Роли пишутся именем и цветом, а не
    одним лишь id: роль могут переименовать или удалить, а журнал должен
    остаться читаемым и после этого.
    """
    before_by_id = {r.id: r for r in before}
    after_by_id = {r.id: r for r in after}
    for role_id, role in after_by_id.items():
        if role_id not in before_by_id:
            log(server, actor, target, ServerAuditLog.ROLE_ADD,
                role_id=role_id, role_name=role.name, role_color=role.color)
    for role_id, role in before_by_id.items():
        if role_id not in after_by_id:
            log(server, actor, target, ServerAuditLog.ROLE_REMOVE,
                role_id=role_id, role_name=role.name, role_color=role.color)
