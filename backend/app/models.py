import os
from sqlmodel import SQLModel, Field
from typing import Optional, List

class Organization(SQLModel, table=True):
    id: str = Field(default_factory=lambda: os.urandom(16).hex(), primary_key=True)
    name: str = Field(index=True, max_length=120)
    slug: str = Field(index=True, max_length=63)
    plan: str = Field(default="free")
    data_region: str = Field(default="us")
    is_personal: bool = Field(default=True)
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    deleted_at: Optional[str] = None

class User(SQLModel, table=True):
    id: str = Field(default_factory=lambda: os.urandom(16).hex(), primary_key=True)
    email: str = Field(index=True)
    email_verified_at: Optional[str] = None
    display_name: Optional[str] = None
    idp_subject: str = Field(index=True)
    locale: str = Field(default="en")
    risk_score: int = Field(default=0)
    free_credits_granted_at: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    deleted_at: Optional[str] = None

class Project(SQLModel, table=True):
    id: str = Field(default_factory=lambda: os.urandom(16).hex(), primary_key=True)
    org_id: str = Field(foreign_key="organization.id")
    created_by: Optional[str] = Field(foreign_key="user.id")
    name: str = Field(max_length=160)
    description: Optional[str] = Field(max_length=2000)
    idea_text: Optional[str] = Field(max_length=20000)
    language: str = Field(default="en")
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    deleted_at: Optional[str] = None

# Additional models (memberships, api_keys, etc.) can be added similarly.

