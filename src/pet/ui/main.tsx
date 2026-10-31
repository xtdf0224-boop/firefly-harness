import { createRoot } from 'react-dom/client';
import { PetApp } from './PetApp';
import '../../styles/pet.css';

createRoot(document.getElementById('root')!).render(<PetApp />);
