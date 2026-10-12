"""Pydantic contracts for the REST API."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class GpsIngest(BaseModel):
    vehicle_number: str = Field(min_length=3, max_length=20)
    vehicle_type: str = Field(default="car", pattern="^(car|bus|emergency)$")
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    speed_kmh: float = Field(ge=0, le=300)
    timestamp: datetime | None = None
    segment_id: int | None = None  # optional; map-matched when absent


class GpsBatch(BaseModel):
    points: list[GpsIngest] = Field(min_length=1, max_length=500)


class VehicleCreate(BaseModel):
    vehicle_number: str = Field(min_length=3, max_length=20)
    vehicle_type: str = Field(default="car", pattern="^(car|bus|emergency)$")
    fuel_type: str | None = None
    seating_capacity: int | None = None
    route_number: str | None = None
    emergency_type: str | None = None


class RouteRequestIn(BaseModel):
    source_id: int
    destination_id: int
    user_id: int | None = None
    priority: bool = False  # True = emergency: free-flow weights, ignore congestion
