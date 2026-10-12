"""Central configuration. All tunables come from the environment."""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://traffic:trafficpass@localhost:5432/trafficflowdb"
    traffic_window_minutes: int = 5
    poll_seconds: float = 2.0
    # TomTom Traffic API (optional). Empty key = disabled. Set via .env, never commit.
    # Cost knobs: free tier ≈ 2,500 tx/day. Default cadence (300s × 4 segs) ≈ 1,150/day.
    tomtom_api_key: str = ""
    tomtom_enabled: bool = True
    tomtom_interval_sec: int = 240
    tomtom_batch_size: int = 4
    tomtom_daily_budget: int = 2000
    tomtom_min_confidence: float = 0.0

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
