from django.urls import path

from . import views

urlpatterns = [
    path("errors", views.ErrorIngest.as_view(), name="error-ingest"),
]
