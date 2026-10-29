"""Comandos de linha de comando.

  docker compose exec api python -m app.cli criar-admin --email voce@empresa.com --nome "Seu Nome"

A senha é pedida no terminal (ou lida de ROTEAR_SENHA, para automação).
"""
import argparse
import getpass
import os
import sys

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Usuario
from app.seguranca import gerar_hash, validar_senha_nova


def criar_admin(email: str, nome: str) -> int:
    email = email.strip().lower()
    senha = os.environ.get("ROTEAR_SENHA")
    if senha is None:
        senha = getpass.getpass("Senha: ")
        if senha != getpass.getpass("Repita a senha: "):
            print("As senhas não conferem.", file=sys.stderr)
            return 1
    if erro := validar_senha_nova(senha):
        print(erro, file=sys.stderr)
        return 1
    with SessionLocal() as db:
        if db.scalar(select(Usuario).where(Usuario.email == email)):
            print(f"Já existe um usuário com o e-mail {email}.", file=sys.stderr)
            return 1
        db.add(Usuario(email=email, nome=nome.strip(), senha_hash=gerar_hash(senha), papel="admin"))
        db.commit()
    print(f"Admin {email} criado.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="comando", required=True)
    p = sub.add_parser("criar-admin", help="cria um usuário administrador")
    p.add_argument("--email", required=True)
    p.add_argument("--nome", required=True)
    args = parser.parse_args()
    if args.comando == "criar-admin":
        return criar_admin(args.email, args.nome)
    return 1


if __name__ == "__main__":
    sys.exit(main())
