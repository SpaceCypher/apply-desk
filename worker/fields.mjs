// Return only clear, explicitly supported matches. Unknown questions are left for review.
export function profileField(label) {
  const text = label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const labels = {
    first_name: ['first name', 'given name'],
    last_name: ['last name', 'surname', 'family name'],
    email: ['email', 'email address'],
    phone: ['phone', 'phone number', 'mobile', 'mobile number'],
    location: ['location', 'city'],
    linkedin: ['linkedin', 'linkedin url', 'linkedin profile'],
    github: ['github', 'github url', 'github profile'],
    portfolio: ['website', 'portfolio', 'portfolio url', 'personal website', 'personal website url'],
    full_name: ['name', 'full name', 'your name', 'legal name'],
  }
  return Object.keys(labels).find(key => labels[key].includes(text))
}

// Value for a matched field. full_name is derived from first and last name.
export function profileValue(profile, field) {
  if (field === 'full_name') return [profile.first_name, profile.last_name].filter(Boolean).join(' ')
  return typeof profile[field] === 'string' ? profile[field] : ''
}
