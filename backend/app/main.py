import os
from fastapi import FastAPI
from .database import init_db, get_session
from sqlmodel import SQLModel
from .routers import users, orgs, projects

app = FastAPI(title="SpecForge API")

@app.on_event("startup")
def on_startup():
    init_db()

app.include_router(users.router, prefix="/users", tags=["users"])
app.include_router(orgs.router, prefix="/orgs", tags=["organizations"])
app.include_router(projects.router, prefix="/projects", tags=["projects"])

