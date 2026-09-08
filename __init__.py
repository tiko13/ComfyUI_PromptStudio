from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import routes  # noqa: F401
from .product_services import publish_services
from .job_observability import shared_job_ledger, shared_job_status
from .job_routes import register_job_routes

publish_services(**{name: getattr(routes, name) for name in (
    "shared_llm_generate", "shared_llm_run", "shared_llm_status", "shared_llm_abort",
    "shared_llm_check_admission", "shared_llm_shutdown", "LlmOverloadedError",
)}, shared_job_ledger=shared_job_ledger, shared_job_status=shared_job_status)
register_job_routes(routes.PromptServer.instance)
from . import provenance_routes  # noqa: F401
from .setup_routes import register_setup_routes
register_setup_routes(routes.PromptServer.instance)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
