"""Entry point: `uvicorn doctus.main:app --reload`"""

from .api import create_app

app = create_app()
