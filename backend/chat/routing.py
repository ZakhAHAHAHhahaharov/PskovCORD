from django.urls import path

from .consumers import GatewayConsumer

websocket_urlpatterns = [
    path("ws/gateway", GatewayConsumer.as_asgi()),
]
