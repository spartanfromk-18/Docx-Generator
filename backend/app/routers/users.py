from fastapi import APIRouter, HTTPException, Depends
from sqlmodel import Session, select
from ..database import get_session
from ..models import User

router = APIRouter()

@router.get("/")
async def list_users(session: Session = Depends(get_session)):
    users = session.exec(select(User)).all()
    return users

