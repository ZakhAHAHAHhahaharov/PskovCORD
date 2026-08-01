from django.urls import path

from . import views

urlpatterns = [
    path("bug-reports", views.BugReportCreate.as_view(), name="bug-report-create"),
]
