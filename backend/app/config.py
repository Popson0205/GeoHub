from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "dev"
    database_url: str                # Supabase: use the session pooler or direct connection string (port 5432)
    db_pool_max: int = 10            # keep below your Supabase plan's connection limit, shared by api + worker + backup
    redis_url: str = "redis://localhost:6379/0"
    jwt_secret: str
    access_token_minutes: int = 15
    refresh_token_days: int = 60
    tile_token_minutes: int = 60
    public_base_url: str = "http://localhost:8000"
    app_url: str = "http://localhost:5173"
    cors_origins: str = "http://localhost:5173"
    trust_proxy: bool = False
    api_prefix: str = ""             # "/api" when the API and the built web app are served from one service
    web_dir: str = ""                # folder with the built frontend (index.html); empty = API only

    s3_endpoint: str
    s3_public_endpoint: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str = "hub"
    s3_region: str = "us-east-1"

    martin_url: str = "http://martin:3000"
    titiler_url: str = "http://titiler:8000"

    jobs_inline: bool = False

    rate_limit_enabled: bool = True
    rate_ip_per_min: int = 600
    rate_user_per_min: int = 1200
    rate_login_per_min: int = 10
    rate_register_per_hour: int = 10
    rate_anon_export_per_hour: int = 20
    rate_anon_read_per_min: int = 120
    rate_public_submit_per_hour: int = 300

    max_imagery_bytes: int = 5 * 1024**3
    max_photo_bytes: int = 10 * 1024**2
    max_media_bytes: int = 100 * 1024**2     # audio, video and documents
    max_import_mb: int = 50
    photo_web_px: int = 2048

    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    mail_from: str = "Mapping Hub <no-reply@example.org>"
    sentry_dsn: str = ""
    log_level: str = "INFO"
    backup_retention_days: int = 30

    @model_validator(mode="after")
    def _prod_checks(self):
        if self.env == "prod" and (len(self.jwt_secret) < 32 or self.jwt_secret.startswith("change-me")):
            raise ValueError("JWT_SECRET must be a random string of 32+ characters when ENV=prod")
        return self


settings = Settings()
