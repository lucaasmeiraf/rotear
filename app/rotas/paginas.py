from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from app.deps import exigir_login, usuario_opcional
from app.models import Usuario
from app.templating import templates

router = APIRouter()


@router.get("/")
def inicio():
    return RedirectResponse("/planejar", status_code=303)


@router.get("/planejar")
def planejar(request: Request, usuario: Usuario = Depends(exigir_login)):
    return templates.TemplateResponse(request, "planejar.html", {"usuario": usuario, "secao": "planejar"})


@router.get("/privacidade")
def privacidade(request: Request, usuario: Usuario | None = Depends(usuario_opcional)):
    return templates.TemplateResponse(request, "privacidade.html", {"usuario": usuario, "secao": "privacidade"})

