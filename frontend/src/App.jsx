"use client"

import React from 'react'

function App() {
  return (
    <div style={{padding: '2rem'}}>
      <h1>SpecForge Frontend</h1>
      <p>Welcome to the SpecForge UI. Connect to the backend at {process.env.VITE_BACKEND_URL}.</p>
    </div>
  )
}

export default App

